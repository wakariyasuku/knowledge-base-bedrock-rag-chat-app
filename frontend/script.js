// グローバル変数
const API_URL = 'https://oltjuqzkdl.execute-api.us-west-2.amazonaws.com/prod';
let conversationId = localStorage.getItem('conversationId') || null;
let isLoading = false;

// DOM要素
const form = document.getElementById('chat-form');
const input = document.getElementById('query-input');
const messagesContainer = document.getElementById('messages-container');
const clearButton = document.getElementById('clear-btn');

// イベントリスナーの設定
document.addEventListener('DOMContentLoaded', () => {
  // 会話履歴の取得
  if (conversationId) {
    fetchConversationHistory();
  }

  // フォーム送信イベント
  form.addEventListener('submit', handleSubmit);
  
  // クリアボタンのイベント
  clearButton.addEventListener('click', handleClearConversation);
});

// 会話履歴を取得する関数
async function fetchConversationHistory() {
  try {
    const response = await fetch(`${API_URL}/history?conversationId=${conversationId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.messages && data.messages.length > 0) {
        // 空の状態メッセージをクリア
        messagesContainer.innerHTML = '';
        
        // メッセージを表示
        data.messages.forEach(message => {
          addMessageToUI(message.role, message.content);
        });
        
        // 一番下までスクロール
        scrollToBottom();
      }
    }
  } catch (error) {
    console.error('Error fetching conversation history:', error);
  }
}

// フォーム送信ハンドラ
async function handleSubmit(e) {
  e.preventDefault();
  
  const query = input.value.trim();
  if (!query || isLoading) return;
  
  // ユーザーメッセージをUIに追加
  addMessageToUI('user', query);
  
  // 入力欄をクリア
  input.value = '';
  
  // ローディング状態を表示
  setLoading(true);

  try {
    const response = await fetch(`${API_URL}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query,
        conversationId: conversationId
      }),
    });

    if (response.ok) {
      const data = await response.json();
      
      // 会話IDを保存
      if (data.conversationId) {
        conversationId = data.conversationId;
        localStorage.setItem('conversationId', conversationId);
      }
      
      // 応答メッセージを追加
      if (data.response) {
        addMessageToUI('assistant', data.response);
      }
      
      // 引用ソースがあれば追加
      if (data.sources && data.sources.length > 0) {
        addSourcesMessageToUI(data.sources);
      }
    } else {
      const errorData = await response.json();
      const errorMessage = errorData.error || 'エラーが発生しました。しばらくしてからもう一度お試しください。';
      
      // Aurora DB が再開中かチェック
      if (errorMessage.includes('The Aurora DB instance') && errorMessage.includes('is resuming after being auto-paused')) {
        addMessageToUI('system', 'データベースが起動中です。30秒ほど時間を空けて再度質問を送信してください。');
      } else {
        // 通常のエラーメッセージを表示
        addMessageToUI('system', errorMessage);
      }
    }
  } catch (error) {
    console.error('Error:', error);
    
    // エラーメッセージにAuroraの再開メッセージが含まれているかチェック
    if (error.message && (
        error.message.includes('The Aurora DB instance') && 
        error.message.includes('is resuming after being auto-paused')
      )) {
      addMessageToUI('system', 'データベースが起動中です。30秒ほど時間を空けて再度質問を送信してください。');
    } else {
      addMessageToUI('system', 'ネットワークエラーが発生しました。インターネット接続を確認してください。');
    }
  } finally {
    setLoading(false);
    scrollToBottom();
  }
}

// 会話クリアハンドラ
async function handleClearConversation() {
  if (!conversationId) return;
  
  try {
    const response = await fetch(`${API_URL}/history`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ conversationId }),
    });
    
    if (response.ok) {
      // UIをクリア
      messagesContainer.innerHTML = `
        <div class="empty-state">
          <p>何か質問してください...</p>
        </div>
      `;
      
      // ローカルストレージをクリア
      localStorage.removeItem('conversationId');
      conversationId = null;
    }
  } catch (error) {
    console.error('Error clearing conversation:', error);
  }
}

// メッセージをUIに追加する関数
function addMessageToUI(role, content) {
  // 最初のempty-stateを削除
  const emptyState = messagesContainer.querySelector('.empty-state');
  if (emptyState) {
    messagesContainer.removeChild(emptyState);
  }
  
  // メッセージ要素を作成
  const messageElement = document.createElement('div');
  messageElement.className = `message ${role}`;

  // AIのメッセージならアイコンを追加
  if (role === 'assistant') {
    const avatar = document.createElement('img');
    avatar.src = 'ai-icon.png'; // ここに適切な画像パスを設定
    avatar.alt = 'AI';
    avatar.className = 'avatar';
    messageElement.appendChild(avatar);
  }
  
  // メッセージ内容を追加
  const contentElement = document.createElement('div');
  contentElement.className = 'message-content';
  
  // 改行を処理
  content.split('\n').forEach(line => {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    contentElement.appendChild(paragraph);
  });
  
  messageElement.appendChild(contentElement);
  messagesContainer.appendChild(messageElement);

  // メッセージ追加後にスクロール
  scrollToBottom();
}


// ソース情報をUIに追加する関数
function addSourcesMessageToUI(sources) {
  // ソースメッセージ要素を作成
  const sourceElement = document.createElement('div');
  sourceElement.className = 'message system';
  
  // メッセージ内容を追加
  const contentElement = document.createElement('div');
  contentElement.className = 'message-content';
  
  const paragraph = document.createElement('p');
  paragraph.textContent = '参考資料:';
  contentElement.appendChild(paragraph);
  
  // ソースリストを追加
  const sourcesList = document.createElement('div');
  sourcesList.className = 'sources';
  
  const ul = document.createElement('ul');
  sources.forEach(source => {
    const li = document.createElement('li');
    
    // リンク（<a>タグ）の代わりに単純なテキストノードを使用
    const textNode = document.createTextNode(source.title || source.url);
    li.appendChild(textNode);
    
    ul.appendChild(li);
  });
  
  sourcesList.appendChild(ul);
  contentElement.appendChild(sourcesList);
  sourceElement.appendChild(contentElement);
  messagesContainer.appendChild(sourceElement);
}

// ローディング状態を設定する関数
function setLoading(loading) {
  isLoading = loading;
  
  // ローディングインジケーターを表示または非表示
  const existingIndicator = messagesContainer.querySelector('.loading-indicator-container');
  
  if (loading) {
    if (!existingIndicator) {
      const loadingElement = document.createElement('div');
      loadingElement.className = 'message system loading-indicator-container';
      
      const loadingIndicator = document.createElement('div');
      loadingIndicator.className = 'loading-indicator';
      
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('div');
        dot.className = 'dot';
        loadingIndicator.appendChild(dot);
      }
      
      loadingElement.appendChild(loadingIndicator);
      messagesContainer.appendChild(loadingElement);
    }
  } else if (existingIndicator) {
    messagesContainer.removeChild(existingIndicator);
  }
  
  // 送信ボタンを無効化または有効化
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = loading;
}

// 一番下までスクロールする関数
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}