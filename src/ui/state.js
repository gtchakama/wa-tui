const state = {
  screen: 'loading', // 'loading', 'qr', 'chats', 'chatDetail'
  qr: null,
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
  error: null,
  unreadCount: 0
};

module.exports = state;
