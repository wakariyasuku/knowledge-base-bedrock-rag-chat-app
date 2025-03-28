from langchain_aws import AmazonKnowledgeBasesRetriever
from langchain_aws import ChatBedrockConverse
from langchain_core.messages import HumanMessage, AIMessage
from langchain.chains import ConversationChain
from langchain.memory import ConversationBufferMemory
from langchain_community.chat_message_histories import DynamoDBChatMessageHistory
import os
import json
import uuid
import decimal

# 環境変数
KB_ID = os.environ.get('KB_ID')
MODEL_ID = os.environ.get('MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
HISTORY_TABLE_NAME = os.environ.get('HISTORY_TABLE_NAME', 'ChatMessageHistory')

# Decimal型をJSONにシリアライズするための関数
def decimal_serializer(obj):
    if isinstance(obj, decimal.Decimal):
        return float(obj)
    raise TypeError("Type not serializable")

# Retriever の初期化
retriever = AmazonKnowledgeBasesRetriever(
    knowledge_base_id=KB_ID,
    retrieval_config={
        "vectorSearchConfiguration": {
            "numberOfResults": 4
        }
    }
)

# Chat モデルの初期化
chat = ChatBedrockConverse(
    model_id=MODEL_ID,
    temperature=0.5,
    max_tokens=1000
)

def create_dynamodb_history(conversation_id):
    """
    DynamoDB Chat Message Historyを作成
    """
    return DynamoDBChatMessageHistory(
        table_name=HISTORY_TABLE_NAME,
        session_id=conversation_id,
        primary_key_name="SessionId"
    )

def lambda_handler(event, context):
    """
    Lambda関数のエントリーポイント
    """

    http_method = event.get('httpMethod', '')
    path = event.get('path', '')

    if http_method == 'POST' and path.endswith('/query'):
        return handle_query(event)
    elif http_method == 'GET' and path.endswith('/history'):
        return handle_get_history(event)
    elif http_method == 'DELETE' and path.endswith('/history'):
        return handle_delete_history(event)
    else:
        return {
            'statusCode': 400,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': '無効なリクエスト'})
        }

def handle_query(event):
    """
    クエリリクエストの処理
    """
    try:
        body = json.loads(event.get('body', '{}'))
        query = body.get('query', '')

        conversation_id = body.get('conversationId')
        if not conversation_id:
            conversation_id = str(uuid.uuid4())
            print(f"新しい会話ID生成: {conversation_id}")
        else:
            print(f"提供された会話ID: {conversation_id}")
        

        if not query:
            return create_response(400, {'error': 'クエリが必要です'})

        try:
            # クエリテキストのログ出力
            print(f"処理するクエリテキスト: {query}")
            
            result = query_with_langchain(conversation_id, query)
            response_text = result.get('response', '')
            sources = result.get('sources', [])

            return create_response(200, {
                'response': response_text,
                'sources': sources,
                'conversationId': conversation_id
            })

        except Exception as e:
            print(f"Bedrock APIエラー: {str(e)}")
            return create_response(500, {'error': f'Bedrock APIエラー: {str(e)}'})

    except Exception as e:
        print(f"エラー: {str(e)}")
        return create_response(500, {'error': f'サーバー内部エラー: {str(e)}'})

def query_with_langchain(conversation_id, query_text):
    """
    LangChainを使ってクエリを処理する
    """
    try:
        global chat, retriever

        # DynamoDB Chat Message History の初期化
        history = create_dynamodb_history(conversation_id)

        # メモリの初期化
        memory = ConversationBufferMemory(
            chat_memory=history,
            return_messages=True
        )

        # 会話チェーンの初期化
        chain = ConversationChain(
            llm=chat,
            memory=memory,
            verbose=True
        )

        # 関連ドキュメントの取得
        retrieved_docs = retriever.get_relevant_documents(query_text)
        print(f"取得したドキュメント数: {len(retrieved_docs)}")

        # 各ドキュメントのメタデータを詳細に出力
        for i, doc in enumerate(retrieved_docs):
            print(f"ドキュメント {i+1} のメタデータ: {doc.metadata}")
            print(f"ドキュメント {i+1} の内容プレビュー: {doc.page_content[:50]}...")

        # コンテキスト作成
        context = "\n\n".join([doc.page_content for doc in retrieved_docs])
        
        # sources生成部分を修正
        unique_files = set()  # ユニークなファイル名を追跡
        sources = []

        for doc in retrieved_docs:
            # S3ロケーションのURIからファイル名を抽出
            file_name = "ドキュメント"  # デフォルト値
            
            # S3パスからファイル名を抽出する
            if 'location' in doc.metadata and 's3Location' in doc.metadata['location']:
                s3_uri = doc.metadata['location']['s3Location'].get('uri', '')
                if s3_uri:
                    # 最後の/以降をファイル名として取得
                    file_name = s3_uri.split('/')[-1]
            
            # ファイル名が既に追加されていない場合のみ追加
            if file_name not in unique_files:
                unique_files.add(file_name)
                sources.append({
                    'title': file_name,
                    'url': doc.metadata.get('source_uri', '#')
                })

        # プロンプト作成
        prompt = f"""以下の情報を参考にして質問に回答してください:

{context}

質問: {query_text}
"""
        print(f"生成したプロンプト: {prompt[:200]}...")

        # LangChain に問い合わせ
        result = chain.invoke(query_text)

        response_text = result.get("response", "")

        return {
            'response': response_text,
            'sources': sources
        }

    except Exception as e:
        print(f"Langchainクエリエラー: {str(e)}")
        raise

def handle_get_history(event):
    """
    会話履歴の取得
    """
    try:
        query_params = event.get('queryStringParameters', {}) or {}
        conversation_id = query_params.get('conversationId')

        if not conversation_id:
            return create_response(400, {'error': '会話IDが必要です'})

        history = create_dynamodb_history(conversation_id)
        
        messages = []
        for msg in history.messages:
            if isinstance(msg, HumanMessage):
                messages.append({"role": "user", "content": msg.content})
            elif isinstance(msg, AIMessage):
                messages.append({"role": "assistant", "content": msg.content})
        
        return create_response(200, {'messages': messages})

    except Exception as e:
        print(f"エラー: {str(e)}")
        return create_response(500, {'error': f'サーバー内部エラー: {str(e)}'})

def handle_delete_history(event):
    """
    会話履歴の削除
    """
    try:
        query_params = event.get('queryStringParameters', {}) or {}
        body = json.loads(event.get('body', '{}'))
        conversation_id = body.get('conversationId') or query_params.get('conversationId')

        if not conversation_id:
            return create_response(400, {'error': '会話IDが必要です'})

        history = create_dynamodb_history(conversation_id)
        history.clear()

        return create_response(200, {'message': '会話履歴が削除されました'})

    except Exception as e:
        print(f"エラー: {str(e)}")
        return create_response(500, {'error': f'サーバー内部エラー: {str(e)}'})
    
def create_response(status_code, body):
    """
    API Gatewayレスポンスの作成
    """
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS,POST,GET,DELETE',
            'Access-Control-Allow-Headers': 'Content-Type'
        },
        'body': json.dumps(body, default=lambda obj: float(obj) if isinstance(obj, decimal.Decimal) else obj)
    }