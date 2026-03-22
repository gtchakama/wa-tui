const state = {
  screen: 'loading', // 'loading', 'qr', 'chats', 'chatDetail'
  qr: null,
  allChats: [],
  chats: [],
  currentChatId: null,
  currentChatName: null,
  currentRawChat: null,
  currentMessages: [],
  /** Saved input per chat id when leaving the thread */
  chatDrafts: {},
  /** absolute paths from Ctrl+D download, keyed by message id */
  mediaPaths: {},
  /** Reply quote target for next send */
  replyTo: null,
  /** Index into currentMessages for quote selection */
  replyPickIndex: null,
  filter: 'all', // 'all', 'direct', 'groups'
  /** 'recent' | 'unread' | 'alpha' */
  chatSort: 'recent',
  unreadOnly: false,
  page: 1,
  pageSize: 10,
  loading: true,
  /** 'init' | 'launching' | 'waiting_auth' | 'qr' | 'authenticated' | 'syncing' | 'loading_chats' | 'ready' */
  loadingPhase: 'init',
  error: null,
  unreadCount: 0,
  searchOpen: false,
  searchReturnScreen: null,
  searchHitMessageId: null,
  /** When opening Settings (F2), where to return: chats | chatDetail */
  settingsReturnScreen: null,
  /** Remote peer composing: 'typing' | 'recording' | null (current chat only) */
  peerTypingState: null
};

module.exports = state;
