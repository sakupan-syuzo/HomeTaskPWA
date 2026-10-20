/**
 * ファミリータスク＆置時計ボード - メインアプリケーション (app.js)
 * Google Pixel Tablet（横向き・スタンド設置）向けPWA
 *
 * 【対応機能】
 * - 子どもの用意：子ども 1〜4人 対応（子ども別の進捗管理）
 * - 3状態切替：「未完了 (todo)」→「完了/やった (done)」→「不要 (skip)」
 * - おむつ補充：子どもごとに毎回枚数を入力する方式（戻り時刻まで有効）
 * - 燃えるごみ・不燃ごみ等の曜日指定＆「前日からの事前表示（明日バッジ付き）」対応
 * - 照度連動2段階自動夜間モード（照度センサー → 時間帯）、日付の区切り時刻設定、Screen Wake Lock API
 */

(() => {
  'use strict';

  // ==========================================================================
  // 定数・ストレージキー定義
  // ==========================================================================
  const STORAGE_KEYS = {
    STATE_V2: 'hometask_state_v2',
    THEME_MODE: 'hometask_theme_mode_v1',
    AUTO_RESET_CONFIG: 'hometask_auto_reset_config_v1',
    DIAPER_RETURN_TIME: 'hometask_diaper_return_time_v1'
  };

  const STATE_VERSION = 4; // バージョン4: おむつの枚数管理を毎回入力方式に変更

  // ==========================================================================
  // テスト用時刻上書き（開発用）
  // ==========================================================================
  let testTimeOffset = null;
  let testTimeBase = null;
  let isTestMode = false;

  (function initTestTime() {
    const params = new URLSearchParams(window.location.search);
    const nowParam = params.get('now');
    const testReset = params.get('testreset');

    if (nowParam) {
      const parsedDate = new Date(nowParam);
      if (!isNaN(parsedDate.getTime())) {
        testTimeBase = parsedDate.getTime();
        testTimeOffset = Date.now();
        isTestMode = true;

        // &testreset=1 が指定されている場合は test_ のデータを削除
        if (testReset === '1') {
          Object.keys(STORAGE_KEYS).forEach(key => {
            const storageKey = STORAGE_KEYS[key];
            localStorage.removeItem('test_' + storageKey);
          });
        }

        // test_ のデータがない場合のみ、通常データをコピー
        const hasTestData = Object.keys(STORAGE_KEYS).some(key => {
          const storageKey = STORAGE_KEYS[key];
          return localStorage.getItem('test_' + storageKey) !== null;
        });

        if (!hasTestData) {
          // 通常データをtest_付きキーにコピー
          Object.keys(STORAGE_KEYS).forEach(key => {
            const storageKey = STORAGE_KEYS[key];
            const value = localStorage.getItem(storageKey);
            if (value !== null) {
              localStorage.setItem('test_' + storageKey, value);
            }
          });
        }
      }
    }
  })();

  function getCurrentTime() {
    if (testTimeBase !== null && testTimeOffset !== null) {
      const elapsed = Date.now() - testTimeOffset;
      return new Date(testTimeBase + elapsed);
    }
    return new Date();
  }

  function getStorageKey(key) {
    return isTestMode ? 'test_' + key : key;
  }

  // 照度センサー（AmbientLightSensor）のヒステリシス設定
  const LUX_CONFIG = {
    DARK_THRESHOLD: 20,    // 20 lux 未満が3秒以上継続で夜間モードON
    BRIGHT_THRESHOLD: 40,  // 40 lux 以上が3秒以上継続で夜間モードOFF
    HOLD_DURATION_MS: 3000
  };

  // 時間帯フォールバック設定（21:00 〜 翌 06:00）
  const NIGHT_HOURS = {
    START: 21,
    END: 6
  };

  // 毎朝のリセット時刻（朝 4:00）
  const RESET_HOUR = 4;

  // 無操作時に全画面時計スクリーンセーバーへ移行する時間（5分 = 300,000ms）
  const IDLE_SCREENSAVER_MS = 5 * 60 * 1000;

  const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

  // 初期データ生成関数
  function createDefaultAppState() {
    return {
      version: STATE_VERSION,
      clockStyle: 'analog', // 'analog' | 'digital' （時計エリアタップでいつでも切替可）
      childCount: 1, // 1〜4人で増減可能
      children: [
        { id: 1, name: '子ども1', disabledTaskIds: [] },
        { id: 2, name: '子ども2', disabledTaskIds: [] },
        { id: 3, name: '子ども3', disabledTaskIds: [] },
        { id: 4, name: '子ども4', disabledTaskIds: [] }
      ],
      // 🎒 子どもの用意（各子どもに対して評価される項目）
      // childStates: { "1": { value: 'done' | 'skip', forDate: 'YYYY-MM-DD', phase?: 'prev' }, ... }
      // おむつタスク (isDiaper: true) の場合：
      // childStates: { "1": { value: 'done' | 'skip' | 'todo', count: number, inputTimestamp: number }, ... }
      // - count: 入力した枚数（undefined = 未入力）
      // - inputTimestamp: 入力した時刻（ミリ秒）
      // - value: 状態（count===0なら自動で'skip'）
      nurseryTasks: [
        { id: 'nursery-1', icon: '🌡️', title: '検温・連絡帳の記入', isDiaper: false, days: 'everyday', showPrevDay: false, carryOverPrevDay: true, childStates: {} },
        { id: 'nursery-2', icon: '🩲', title: 'オムツ補充', isDiaper: true, days: 'everyday', showPrevDay: false, carryOverPrevDay: true, childStates: {} },
        { id: 'nursery-3', icon: '👕', title: '着替え・エプロン', isDiaper: false, days: 'everyday', showPrevDay: false, carryOverPrevDay: true, childStates: {} },
        { id: 'nursery-4', icon: '🍼', title: '水筒の準備', isDiaper: false, days: 'everyday', showPrevDay: false, carryOverPrevDay: true, childStates: {} },
        { id: 'nursery-5', icon: '🛍️', title: '汚れ物袋', isDiaper: false, days: 'everyday', showPrevDay: false, carryOverPrevDay: true, childStates: {} }
      ],
      // 🏠 今日の家事・ゴミ出し
      // status: { value: 'done' | 'skip', forDate: 'YYYY-MM-DD', phase?: 'prev' } または null
      choresTasks: [
        { id: 'garbage-burnable', icon: '🔥', title: '燃えるゴミ出し', isGarbageConfig: true, days: [2, 5], showPrevDay: true, carryOverPrevDay: false, status: null },
        { id: 'garbage-nonburnable', icon: '🥫', title: '不燃ごみ出し', isGarbageConfig: true, days: [4], showPrevDay: true, carryOverPrevDay: false, status: null },
        { id: 'garbage-resource', icon: '♻️', title: '資源ごみ', isGarbageConfig: true, days: [3], showPrevDay: true, carryOverPrevDay: false, status: null },
        { id: 'chores-3', icon: '🍽️', title: '食洗機を回す', isGarbageConfig: false, days: 'everyday', showPrevDay: false, carryOverPrevDay: true, status: null },
        { id: 'chores-4', icon: '🧺', title: '洗濯予約', isGarbageConfig: false, days: 'everyday', showPrevDay: false, carryOverPrevDay: true, status: null },
        { id: 'chores-5', icon: '🛏️', title: 'お昼寝シーツ準備', isGarbageConfig: false, days: [1], showPrevDay: true, carryOverPrevDay: true, status: null }
      ]
    };
  }

  // ==========================================================================
  // アプリケーション状態
  // ==========================================================================
  let appState = createDefaultAppState();
  let themeMode = 'auto'; // 'auto' | 'light' | 'dark'
  let currentRenderedDayOfWeek = null;

  // 日付の区切り時刻設定（旧：自動リセット設定）
  let dateResetConfig = {
    hour: 4,
    minute: 0
  };

  // おむつの戻り時刻設定（保育園からの帰宅時刻）
  let diaperReturnTime = {
    hour: 15,
    minute: 0
  };

  // 照度センサー＆テーマ制御用状態
  let sensorActive = false;
  let currentLux = null;
  let sensorDarkState = null;       // null(未確定) | true(夜間) | false(昼間)
  let pendingLuxTargetState = null; // ヒステリシス待機中の遷移先状態
  let luxHysteresisTimer = null;

  // Wake Lock 状態
  let wakeLockSentinel = null;

  // 5分無操作スクリーンセーバー状態＆誤操作防止ガード
  let idleTimer = null;
  let isScreensaverActive = false;
  let wakeGuardUntil = 0;

  // ==========================================================================
  // DOM要素参照
  // ==========================================================================
  const dom = {
    html: document.documentElement,
    metaThemeColor: document.getElementById('meta-theme-color'),
    testModeBadge: document.getElementById('test-mode-badge'),
    clockSection: document.getElementById('clock-section'),
    clockStylePill: document.getElementById('clock-style-pill'),
    analogClockWrap: document.getElementById('analog-clock-wrap'),
    analogTicks: document.getElementById('analog-ticks'),
    analogNumbers: document.getElementById('analog-numbers'),
    analogHourHand: document.getElementById('analog-hour-hand'),
    analogMinHand: document.getElementById('analog-min-hand'),
    analogSecHand: document.getElementById('analog-sec-hand'),
    dateDisplay: document.getElementById('date-display'),
    clockHm: document.getElementById('clock-hm'),
    clockSec: document.getElementById('clock-sec'),
    // 全画面時計スクリーンセーバー要素
    screensaverOverlay: document.getElementById('screensaver-overlay'),
    ssDateDisplay: document.getElementById('ss-date-display'),
    ssAnalogWrap: document.getElementById('ss-analog-wrap'),
    ssAnalogTicks: document.getElementById('ss-analog-ticks'),
    ssAnalogNumbers: document.getElementById('ss-analog-numbers'),
    ssAnalogHourHand: document.getElementById('ss-analog-hour-hand'),
    ssAnalogMinHand: document.getElementById('ss-analog-min-hand'),
    ssAnalogSecHand: document.getElementById('ss-analog-sec-hand'),
    ssClockHm: document.getElementById('ss-clock-hm'),
    ssClockSec: document.getElementById('ss-clock-sec'),
    ssProgressPill: document.getElementById('ss-progress-pill'),
    progressCounter: document.getElementById('progress-counter'),
    progressBarTrack: document.getElementById('progress-bar-track'),
    progressBarFill: document.getElementById('progress-bar-fill'),
    celebrationBanner: document.getElementById('celebration-banner'),
    wakelockDot: document.getElementById('wakelock-dot'),
    wakelockText: document.getElementById('wakelock-text'),
    sensorDot: document.getElementById('sensor-dot'),
    sensorText: document.getElementById('sensor-text'),
    autoResetStatus: document.getElementById('auto-reset-status'),
    autoResetDot: document.getElementById('auto-reset-dot'),
    autoResetText: document.getElementById('auto-reset-text'),
    btnInstallPwa: document.getElementById('btn-install-pwa'),
    btnFullscreenClock: document.getElementById('btn-fullscreen-clock'),
    btnThemeToggle: document.getElementById('btn-theme-toggle'),
    themeBtnIcon: document.getElementById('theme-btn-icon'),
    themeBtnLabel: document.getElementById('theme-btn-label'),
    btnManualReset: document.getElementById('btn-manual-reset'),
    btnOpenEditor: document.getElementById('btn-open-editor'),
    sectionNursery: document.getElementById('section-nursery'),
    gridNursery: document.getElementById('grid-nursery'),
    gridChores: document.getElementById('grid-chores'),
    catNurseryCount: document.getElementById('cat-nursery-count'),
    catChoresCount: document.getElementById('cat-chores-count'),
    // 自動リセット設定モーダル
    autoResetConfigModal: document.getElementById('auto-reset-config-modal'),
    autoResetHourInput: document.getElementById('auto-reset-hour-input'),
    autoResetMinuteInput: document.getElementById('auto-reset-minute-input'),
    btnCancelAutoResetConfig: document.getElementById('btn-cancel-auto-reset-config'),
    btnSaveAutoResetConfig: document.getElementById('btn-save-auto-reset-config'),
    // リセット確認モーダル
    resetModal: document.getElementById('reset-modal'),
    btnCancelReset: document.getElementById('btn-cancel-reset'),
    btnConfirmReset: document.getElementById('btn-confirm-reset'),
    // おむつ枚数入力パネル
    diaperInputModal: document.getElementById('diaper-input-modal'),
    diaperInputTitle: document.getElementById('diaper-input-title'),
    diaperInputButtons: document.getElementById('diaper-input-buttons'),
    btnCancelDiaperInput: document.getElementById('btn-cancel-diaper-input'),
    // 設定・タスク編集モーダル
    editorModal: document.getElementById('editor-modal'),
    btnCloseEditor: document.getElementById('btn-close-editor'),
    btnDoneEditor: document.getElementById('btn-done-editor'),
    btnRestoreDefaults: document.getElementById('btn-restore-defaults'),
    childCountButtons: document.getElementById('child-count-buttons'),
    childrenConfigGrid: document.getElementById('children-config-grid'),
    garbageConfigList: document.getElementById('garbage-config-list'),
    diaperReturnHourInput: document.getElementById('diaper-return-hour-input'),
    diaperReturnMinuteInput: document.getElementById('diaper-return-minute-input'),
    btnSaveDiaperReturnTime: document.getElementById('btn-save-diaper-return-time'),
    addTaskForm: document.getElementById('add-task-form'),
    inputTaskIcon: document.getElementById('input-task-icon'),
    inputTaskTitle: document.getElementById('input-task-title'),
    inputTaskCategory: document.getElementById('input-task-category'),
    inputTaskShowPrevDay: document.getElementById('input-task-show-prev-day'),
    inputTaskCarryOver: document.getElementById('input-task-carry-over'),
    emojiPresets: document.getElementById('emoji-presets'),
    btnDaysEveryday: document.getElementById('btn-days-everyday'),
    dayCheckboxesContainer: document.getElementById('day-checkboxes'),
    editorListNursery: document.getElementById('editor-list-nursery'),
    editorListChores: document.getElementById('editor-list-chores')
  };

  // ==========================================================================
  // 1. 論理日付（朝4:00基準）＆毎朝4:00の自動リセット機能
  // ==========================================================================

  /**
   * 設定されたリセット時刻を1日の区切りとした「論理日付 (YYYY-MM-DD)」を返す
   */
  function getLogicalDateString(now = getCurrentTime()) {
    const shiftMs = dateResetConfig.hour * 60 * 60 * 1000 + dateResetConfig.minute * 60 * 1000;
    const shifted = new Date(now.getTime() - shiftMs);
    const y = shifted.getFullYear();
    const m = String(shifted.getMonth() + 1).padStart(2, '0');
    const d = String(shifted.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * 設定されたリセット時刻で区切った論理日付のDateオブジェクトを返す
   * 曜日判定などに使用
   */
  function getLogicalDate(now) {
    const shiftMs = dateResetConfig.hour * 60 * 60 * 1000 + dateResetConfig.minute * 60 * 1000;
    return new Date(now.getTime() - shiftMs);
  }

  /**
   * 指定したDateオブジェクトから論理日付文字列を返す
   */
  function dateToLogicalDateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * 論理日付文字列から翌日の論理日付文字列を返す
   */
  function getNextLogicalDateString(logicalDateStr) {
    const date = new Date(logicalDateStr + 'T00:00:00');
    date.setDate(date.getDate() + 1);
    return dateToLogicalDateString(date);
  }

  // ==========================================================================
  // おむつ専用の時刻管理
  // ==========================================================================

  /**
   * おむつの入力値の有効期限（次の戻り時刻）を計算する
   * @param {number} inputTimestamp - 入力した時刻（ミリ秒）
   * @param {Object} returnTimeConfig - 戻り時刻設定 { hour, minute }
   * @returns {number} - 有効期限のタイムスタンプ（ミリ秒）
   */
  function getDiaperExpiry(inputTimestamp, returnTimeConfig) {
    const inputDate = new Date(inputTimestamp);
    const returnDate = new Date(inputDate);
    returnDate.setHours(returnTimeConfig.hour, returnTimeConfig.minute, 0, 0);

    // 入力時刻が戻り時刻より前なら、同日の戻り時刻が有効期限
    // 入力時刻が戻り時刻以降なら、翌日の戻り時刻が有効期限
    if (inputDate.getTime() >= returnDate.getTime()) {
      returnDate.setDate(returnDate.getDate() + 1);
    }

    return returnDate.getTime();
  }

  /**
   * おむつのデータが期限切れかを判定する
   * @param {number} inputTimestamp - 入力した時刻（ミリ秒）
   * @param {Date} now - 現在時刻
   * @param {Object} returnTimeConfig - 戻り時刻設定 { hour, minute }
   * @returns {boolean} - 期限切れの場合 true
   */
  function isDiaperDataExpired(inputTimestamp, now, returnTimeConfig) {
    const expiry = getDiaperExpiry(inputTimestamp, returnTimeConfig);
    return now.getTime() >= expiry;
  }

  /**
   * 期限切れのおむつデータ（入力値と状態）を削除する
   * @param {Date} now - 現在時刻
   */
  function cleanupExpiredDiaperData(now = getCurrentTime()) {
    let needsSave = false;

    appState.nurseryTasks.forEach((task) => {
      if (!task.isDiaper) return;

      Object.keys(task.childStates).forEach((childId) => {
        const state = task.childStates[childId];
        if (state && typeof state.inputTimestamp === 'number') {
          if (isDiaperDataExpired(state.inputTimestamp, now, diaperReturnTime)) {
            delete task.childStates[childId];
            needsSave = true;
          }
        }
      });
    });

    if (needsSave) {
      saveState();
    }
  }

  /**
   * 古い状態（forDateが今日の論理日付より前）を削除する
   * ※おむつタスクは cleanupExpiredDiaperData で別途管理するため、ここではスキップ
   */
  function cleanupOldTaskStates(now = getCurrentTime()) {
    const todayStr = getLogicalDateString(now);
    const tomorrowStr = getNextLogicalDateString(todayStr);

    // nurseryTasks の古い状態を削除（おむつタスクを除く）
    appState.nurseryTasks.forEach((task) => {
      if (task.isDiaper) return; // おむつは別管理

      Object.keys(task.childStates).forEach((childId) => {
        const state = task.childStates[childId];
        if (state && state.forDate && state.forDate !== todayStr && state.forDate !== tomorrowStr) {
          delete task.childStates[childId];
        }
      });
    });

    // choresTasks の古い状態を削除
    appState.choresTasks.forEach((task) => {
      if (task.status && task.status.forDate && task.status.forDate !== todayStr && task.status.forDate !== tomorrowStr) {
        task.status = null;
      }
    });

    saveState();
  }

  // ==========================================================================
  // 2. LocalStorage データの読み込み・保存
  // ==========================================================================

  function loadState() {
    const savedTheme = localStorage.getItem(getStorageKey(STORAGE_KEYS.THEME_MODE));
    if (savedTheme === 'auto' || savedTheme === 'light' || savedTheme === 'dark') {
      themeMode = savedTheme;
    }

    const rawState = localStorage.getItem(getStorageKey(STORAGE_KEYS.STATE_V2));
    if (rawState) {
      try {
        const parsed = JSON.parse(rawState);
        if (parsed && Array.isArray(parsed.nurseryTasks) && Array.isArray(parsed.choresTasks)) {
          appState = {
            ...createDefaultAppState(),
            ...parsed
          };
          // 子ども配列の補完（1〜4人分必ず保持）
          const defaultChildren = createDefaultAppState().children;
          appState.children = defaultChildren.map((defChild, idx) => {
            const savedChild = parsed.children && parsed.children[idx] ? parsed.children[idx] : {};
            return {
              ...defChild,
              ...savedChild,
              disabledTaskIds: Array.isArray(savedChild.disabledTaskIds) ? savedChild.disabledTaskIds : []
            };
          });
          if (typeof parsed.childCount === 'number' && parsed.childCount >= 0 && parsed.childCount <= 4) {
            appState.childCount = parsed.childCount;
          }
        }
      } catch (e) {
        console.warn('保存データの読み込みに失敗したため初期データを使用します:', e);
        appState = createDefaultAppState();
      }
    } else {
      appState = createDefaultAppState();
      saveState();
    }

    // バージョンチェックとデータ移行
    if (!appState.version || appState.version < STATE_VERSION) {
      migrateTaskStates();
    }

    // carryOverPrevDay の補完（バージョンに関係なく常に実行）
    ensureCarryOverPrevDay();

    // 家事タスクの status を補完（文字列なら null に）
    ensureChoresStatusFormat();

    // 古い状態のクリーンアップ
    cleanupOldTaskStates();

    // おむつデータの期限切れクリーンアップ
    cleanupExpiredDiaperData();
  }

  function saveState() {
    try {
      localStorage.setItem(getStorageKey(STORAGE_KEYS.STATE_V2), JSON.stringify(appState));
    } catch (e) {
      console.error('状態の保存に失敗しました:', e);
    }
  }

  function saveThemeMode() {
    try {
      localStorage.setItem(getStorageKey(STORAGE_KEYS.THEME_MODE), themeMode);
    } catch (e) {
      console.error('テーマ設定の保存に失敗しました:', e);
    }
  }

  function loadDateResetConfig() {
    try {
      const saved = localStorage.getItem(getStorageKey(STORAGE_KEYS.AUTO_RESET_CONFIG));
      if (saved) {
        const parsed = JSON.parse(saved);
        // enabled は無視、hour と minute のみ引き継ぐ
        dateResetConfig = {
          hour: typeof parsed.hour === 'number' ? parsed.hour : 4,
          minute: typeof parsed.minute === 'number' ? parsed.minute : 0
        };
      }
    } catch (e) {
      console.warn('日付区切り設定の読み込みに失敗しました:', e);
    }
  }

  function saveDateResetConfig() {
    try {
      localStorage.setItem(getStorageKey(STORAGE_KEYS.AUTO_RESET_CONFIG), JSON.stringify(dateResetConfig));
    } catch (e) {
      console.error('日付区切り設定の保存に失敗しました:', e);
    }
  }

  function loadDiaperReturnTime() {
    try {
      const saved = localStorage.getItem(getStorageKey(STORAGE_KEYS.DIAPER_RETURN_TIME));
      if (saved) {
        const parsed = JSON.parse(saved);
        diaperReturnTime = {
          hour: typeof parsed.hour === 'number' ? parsed.hour : 15,
          minute: typeof parsed.minute === 'number' ? parsed.minute : 0
        };
      }
    } catch (e) {
      console.warn('おむつ戻り時刻設定の読み込みに失敗しました:', e);
    }
  }

  function saveDiaperReturnTime() {
    try {
      localStorage.setItem(getStorageKey(STORAGE_KEYS.DIAPER_RETURN_TIME), JSON.stringify(diaperReturnTime));
    } catch (e) {
      console.error('おむつ戻り時刻設定の保存に失敗しました:', e);
    }
  }

  /**
   * タスクの carryOverPrevDay を取得するヘルパー関数
   * 値が boolean でない場合は初期値を返す
   * @param {Object} task - タスクオブジェクト
   * @returns {boolean}
   */
  function getCarryOverPrevDay(task) {
    if (typeof task.carryOverPrevDay === 'boolean') {
      return task.carryOverPrevDay;
    }
    // isGarbageConfig が true なら false、それ以外なら true
    return task.isGarbageConfig ? false : true;
  }

  /**
   * すべてのタスクの carryOverPrevDay を補完する（読み込み時に常に実行）
   */
  function ensureCarryOverPrevDay() {
    let needsSave = false;

    // nurseryTasks の補完
    appState.nurseryTasks.forEach((task) => {
      if (typeof task.carryOverPrevDay !== 'boolean') {
        task.carryOverPrevDay = true;
        needsSave = true;
      }
    });

    // choresTasks の補完
    appState.choresTasks.forEach((task) => {
      if (typeof task.carryOverPrevDay !== 'boolean') {
        task.carryOverPrevDay = task.isGarbageConfig ? false : true;
        needsSave = true;
      }
    });

    if (needsSave) {
      saveState();
    }
  }

  /**
   * 家事タスクの status を補完する（文字列なら null に）
   * バージョンに関係なく、読み込むたびに実行
   */
  function ensureChoresStatusFormat() {
    let needsSave = false;

    appState.choresTasks.forEach((task) => {
      if (typeof task.status === 'string') {
        task.status = null;
        needsSave = true;
      }
    });

    if (needsSave) {
      saveState();
    }
  }

  /**
   * データ移行：旧形式（文字列）から新形式（オブジェクト）へ
   */
  function migrateTaskStates() {
    const now = getCurrentTime();
    const todayStr = getLogicalDateString(now);
    let migrated = false;
    const oldVersion = appState.version || 0;

    // バージョン3以前からの移行：nurseryTasks の childStates
    if (oldVersion < 3) {
      appState.nurseryTasks.forEach((task) => {
        // childStates の移行
        Object.keys(task.childStates).forEach((childId) => {
          const state = task.childStates[childId];
          if (typeof state === 'string') {
            // 旧形式（文字列）を新形式に変換
            if (state === 'done' || state === 'skip') {
              task.childStates[childId] = { value: state, forDate: todayStr };
              migrated = true;
            } else {
              // 'todo' は削除
              delete task.childStates[childId];
              migrated = true;
            }
          }
        });
      });

      // choresTasks の移行
      appState.choresTasks.forEach((task) => {
        // status の移行
        if (typeof task.status === 'string') {
          if (task.status === 'done' || task.status === 'skip') {
            task.status = { value: task.status, forDate: todayStr };
            migrated = true;
          } else {
            // 'todo' は null に
            task.status = null;
            migrated = true;
          }
        }
      });
    }

    // バージョン4への移行：おむつの枚数管理変更
    if (oldVersion < 4) {
      // 子どもデータから diaperCount と diaperNotNeeded を削除
      appState.children.forEach((child) => {
        if ('diaperCount' in child) {
          delete child.diaperCount;
          migrated = true;
        }
        if ('diaperNotNeeded' in child) {
          delete child.diaperNotNeeded;
          migrated = true;
        }
      });

      // おむつタスクの childStates をクリア
      appState.nurseryTasks.forEach((task) => {
        if (task.isDiaper) {
          task.childStates = {};
          migrated = true;
        }
      });
    }

    if (migrated) {
      appState.version = STATE_VERSION;
      saveState();
    }
  }

  // ==========================================================================
  // 3. 時計（アナログSVG文字盤＆デジタル）・日付・定期チェック処理
  // ==========================================================================

  /**
   * アナログ時計の60分目盛りと1〜12の数字をSVG上に生成する（メイン＆全画面スクリーンセーバー両方）
   */
  function populateAnalogFaceGroup(ticksGroup, numbersGroup) {
    if (!ticksGroup || !numbersGroup) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    const cx = 130;
    const cy = 130;

    ticksGroup.innerHTML = '';
    numbersGroup.innerHTML = '';

    for (let i = 0; i < 60; i++) {
      const angleDeg = i * 6;
      const angleRad = ((angleDeg - 90) * Math.PI) / 180;
      const isMajor = i % 5 === 0;

      const rOuter = 114;
      const rInner = isMajor ? 102 : 108;

      const x1 = cx + rInner * Math.cos(angleRad);
      const y1 = cy + rInner * Math.sin(angleRad);
      const x2 = cx + rOuter * Math.cos(angleRad);
      const y2 = cy + rOuter * Math.sin(angleRad);

      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', x1.toFixed(2));
      line.setAttribute('y1', y1.toFixed(2));
      line.setAttribute('x2', x2.toFixed(2));
      line.setAttribute('y2', y2.toFixed(2));
      line.setAttribute('class', isMajor ? 'analog-tick-major' : 'analog-tick-minor');
      ticksGroup.appendChild(line);
    }

    for (let h = 1; h <= 12; h++) {
      const angleDeg = h * 30;
      const angleRad = ((angleDeg - 90) * Math.PI) / 180;
      const rNum = 83;

      const nx = cx + rNum * Math.cos(angleRad);
      const ny = cy + rNum * Math.sin(angleRad);

      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', nx.toFixed(2));
      text.setAttribute('y', ny.toFixed(2));
      text.setAttribute('class', 'analog-number');
      text.textContent = String(h);
      numbersGroup.appendChild(text);
    }
  }

  function initAnalogClockFace() {
    populateAnalogFaceGroup(dom.analogTicks, dom.analogNumbers);
    populateAnalogFaceGroup(dom.ssAnalogTicks, dom.ssAnalogNumbers);
  }

  /**
   * アナログ時計 / デジタル時計の表示スタイルを適用する
   */
  function applyClockStyleUI() {
    const isAnalog = appState.clockStyle !== 'digital';
    dom.clockSection.classList.toggle('is-analog', isAnalog);
    dom.analogClockWrap.hidden = !isAnalog;
    if (dom.clockStylePill) {
      dom.clockStylePill.textContent = isAnalog ? '🕰️ アナログ (タップで切替)' : '🔢 デジタル (タップで切替)';
    }

    if (dom.screensaverOverlay && dom.ssAnalogWrap) {
      dom.screensaverOverlay.classList.toggle('is-analog', isAnalog);
      dom.ssAnalogWrap.hidden = !isAnalog;
    }
  }

  /**
   * 時計セクションのタップでアナログ ⇔ デジタルを切り替え
   */
  function toggleClockStyle() {
    appState.clockStyle = appState.clockStyle === 'digital' ? 'analog' : 'digital';
    saveState();
    applyClockStyleUI();
  }

  function updateClockAndSchedule() {
    const now = getCurrentTime();

    const h = now.getHours();
    const m = now.getMinutes();
    const s = now.getSeconds();

    const hours = String(h).padStart(2, '0');
    const minutes = String(m).padStart(2, '0');
    const seconds = String(s).padStart(2, '0');

    dom.clockHm.textContent = `${hours}:${minutes}`;
    dom.clockSec.textContent = seconds;

    if (dom.ssClockHm) {
      dom.ssClockHm.textContent = `${hours}:${minutes}`;
      dom.ssClockSec.textContent = seconds;
    }

    // アナログ時計の針の角度を更新
    const secDeg = s * 6;
    const minDeg = m * 6 + s * 0.1;
    const hourDeg = (h % 12) * 30 + m * 0.5;

    if (dom.analogHourHand) {
      dom.analogHourHand.setAttribute('transform', `rotate(${hourDeg} 130 130)`);
      dom.analogMinHand.setAttribute('transform', `rotate(${minDeg} 130 130)`);
      dom.analogSecHand.setAttribute('transform', `rotate(${secDeg} 130 130)`);
    }

    if (dom.ssAnalogHourHand) {
      dom.ssAnalogHourHand.setAttribute('transform', `rotate(${hourDeg} 130 130)`);
      dom.ssAnalogMinHand.setAttribute('transform', `rotate(${minDeg} 130 130)`);
      dom.ssAnalogSecHand.setAttribute('transform', `rotate(${secDeg} 130 130)`);
    }

    const month = now.getMonth() + 1;
    const date = now.getDate();
    const dayOfWeek = now.getDay();
    const dateStr = `${month}月${date}日 (${DAY_NAMES[dayOfWeek]})`;
    dom.dateDisplay.textContent = dateStr;
    if (dom.ssDateDisplay) {
      dom.ssDateDisplay.textContent = dateStr;
    }

    // 論理日付の曜日が変わった場合は古い状態をクリーンアップして再描画
    const logicalDate = getLogicalDate(now);
    const logicalDayOfWeek = logicalDate.getDay();
    if (currentRenderedDayOfWeek !== logicalDayOfWeek) {
      currentRenderedDayOfWeek = logicalDayOfWeek;
      cleanupOldTaskStates(now);
      renderAll();
    }

    // おむつデータの期限切れチェック（毎秒実行）
    cleanupExpiredDiaperData(now);

    // テーマ再評価
    evaluateAndApplyTheme(now);
  }

  // ==========================================================================
  // 4. 周囲の明るさ（照度）に連動した自動夜間モード（3段階ハイブリッド制御）
  // ==========================================================================

  function isNightTimeWindow(now = new Date()) {
    const hour = now.getHours();
    return hour >= NIGHT_HOURS.START || hour < NIGHT_HOURS.END;
  }

  function initAmbientLightSensor() {
    if (!('AmbientLightSensor' in window)) {
      sensorActive = false;
      updateSensorStatusBadge(getCurrentTime());
      return;
    }

    try {
      const sensor = new window.AmbientLightSensor({ frequency: 1 });

      sensor.addEventListener('reading', () => {
        sensorActive = true;
        currentLux = Math.round(sensor.illuminance);

        if (sensorDarkState === null) {
          sensorDarkState = currentLux < LUX_CONFIG.DARK_THRESHOLD;
          evaluateAndApplyTheme(getCurrentTime());
        } else {
          let desiredState = sensorDarkState;
          if (!sensorDarkState && currentLux < LUX_CONFIG.DARK_THRESHOLD) {
            desiredState = true;
          } else if (sensorDarkState && currentLux >= LUX_CONFIG.BRIGHT_THRESHOLD) {
            desiredState = false;
          }

          if (desiredState !== sensorDarkState) {
            if (pendingLuxTargetState !== desiredState) {
              pendingLuxTargetState = desiredState;
              clearTimeout(luxHysteresisTimer);
              luxHysteresisTimer = setTimeout(() => {
                sensorDarkState = desiredState;
                pendingLuxTargetState = null;
                evaluateAndApplyTheme(getCurrentTime());
                updateSensorStatusBadge(getCurrentTime());
              }, LUX_CONFIG.HOLD_DURATION_MS);
            }
          } else if (luxHysteresisTimer) {
            clearTimeout(luxHysteresisTimer);
            luxHysteresisTimer = null;
            pendingLuxTargetState = null;
          }
        }

        updateSensorStatusBadge(getCurrentTime());
      });

      sensor.addEventListener('error', () => {
        sensorActive = false;
        currentLux = null;
        updateSensorStatusBadge(getCurrentTime());
        evaluateAndApplyTheme(getCurrentTime());
      });

      sensor.start();
    } catch (err) {
      sensorActive = false;
      currentLux = null;
      updateSensorStatusBadge(getCurrentTime());
    }
  }

  function evaluateAndApplyTheme(now = getCurrentTime()) {
    let resolvedTheme = 'light';

    if (themeMode === 'light') {
      resolvedTheme = 'light';
    } else if (themeMode === 'dark') {
      resolvedTheme = 'dark';
    } else {
      // 自動モード（2段階制御）
      if (sensorActive && sensorDarkState !== null) {
        // 第1優先：照度センサー（AmbientLightSensor）が有効な場合は、時間帯に関わらず実際の部屋の明るさで昼/夜を決定
        resolvedTheme = sensorDarkState ? 'dark' : 'light';
      } else {
        // 第2優先：センサー非対応または未取得時は、夜間時間帯（21:00〜翌6:00）で決定
        const inNightWindow = isNightTimeWindow(now);
        resolvedTheme = inNightWindow ? 'dark' : 'light';
      }
    }

    if (dom.html.getAttribute('data-theme') !== resolvedTheme) {
      dom.html.setAttribute('data-theme', resolvedTheme);
      if (dom.metaThemeColor) {
        dom.metaThemeColor.setAttribute('content', resolvedTheme === 'dark' ? '#0a0a0a' : '#f6f3ec');
      }
    }

    updateThemeToggleButtonUI();
    updateSensorStatusBadge(now);
    updateDateResetStatusBadge();
  }

  function updateThemeToggleButtonUI() {
    if (themeMode === 'auto') {
      dom.themeBtnIcon.textContent = '🌓';
      dom.themeBtnLabel.textContent = 'テーマ: 自動';
    } else if (themeMode === 'light') {
      dom.themeBtnIcon.textContent = '☀️';
      dom.themeBtnLabel.textContent = 'テーマ: 昼固定';
    } else {
      dom.themeBtnIcon.textContent = '🌙';
      dom.themeBtnLabel.textContent = 'テーマ: 夜固定';
    }
  }

  function updateSensorStatusBadge(now = getCurrentTime()) {
    if (sensorActive && currentLux !== null) {
      dom.sensorDot.className = 'status-dot active';
      dom.sensorText.textContent = `テーマ: 照度 (${currentLux} lx)`;
    } else {
      dom.sensorDot.className = 'status-dot warn';
      dom.sensorText.textContent = 'テーマ: 時間帯';
    }
  }

  function updateDateResetStatusBadge() {
    if (!dom.autoResetDot || !dom.autoResetText) return;

    dom.autoResetDot.className = 'status-dot active';
    const timeStr = `${String(dateResetConfig.hour).padStart(2, '0')}:${String(dateResetConfig.minute).padStart(2, '0')}`;
    dom.autoResetText.textContent = `日付の区切り: ${timeStr}`;
  }

  function cycleThemeMode() {
    if (themeMode === 'auto') {
      themeMode = 'light';
    } else if (themeMode === 'light') {
      themeMode = 'dark';
    } else {
      themeMode = 'auto';
    }
    saveThemeMode();
    evaluateAndApplyTheme(getCurrentTime());
  }

  // ==========================================================================
  // 5. スリープ防止（Screen Wake Lock API）
  // ==========================================================================

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      dom.wakelockDot.className = 'status-dot';
      dom.wakelockText.textContent = 'Wake Lock: 非対応';
      return;
    }

    if (document.visibilityState !== 'visible') return;
    if (wakeLockSentinel && !wakeLockSentinel.released) {
      updateWakeLockBadge(true);
      return;
    }

    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      updateWakeLockBadge(true);
      wakeLockSentinel.addEventListener('release', () => {
        updateWakeLockBadge(false);
      });
    } catch (err) {
      updateWakeLockBadge(false, true);
    }
  }

  function updateWakeLockBadge(isActive, waitingForTap = false) {
    if (isActive) {
      dom.wakelockDot.className = 'status-dot active';
      dom.wakelockText.textContent = 'スリープ防止: 稼働中';
    } else if (waitingForTap) {
      dom.wakelockDot.className = 'status-dot warn';
      dom.wakelockText.textContent = 'スリープ防止: タップで有効化';
    } else {
      dom.wakelockDot.className = 'status-dot warn';
      dom.wakelockText.textContent = 'スリープ防止: 一時解除';
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      cleanupOldTaskStates(getCurrentTime());
    }
  });

  document.addEventListener('pointerdown', () => {
    if (!wakeLockSentinel || wakeLockSentinel.released) {
      requestWakeLock();
    }
  }, { passive: true });

  // ==========================================================================
  // 6. 曜日判定（当日＆前日表示）・3状態管理（未完了 / 完了 / 不要）
  // ==========================================================================

  /**
   * タスクが今日の曜日に表示対象かを判定し、マッチ種別を返す
   * @returns { null | 'everyday' | 'today' | 'tomorrow' }
   *   - 'everyday': 毎日タスク
   *   - 'today': 今日が指定曜日当日
   *   - 'tomorrow': 明日が指定曜日で、showPrevDay（前日から表示）が有効
   *   - null: 今日は非表示
   */
  function getTaskScheduleMatch(task, todayDayOfWeek) {
    if (task.days === 'everyday' || (Array.isArray(task.days) && task.days.length === 7)) {
      return 'everyday';
    }
    if (!Array.isArray(task.days) || task.days.length === 0) {
      return null;
    }
    // 当日チェック
    if (task.days.includes(todayDayOfWeek)) {
      return 'today';
    }
    // 前日表示チェック（明日の曜日が対象曜日に含まれているか）
    if (task.showPrevDay) {
      const tomorrowDayOfWeek = (todayDayOfWeek + 1) % 7;
      if (task.days.includes(tomorrowDayOfWeek)) {
        return 'tomorrow';
      }
    }
    return null;
  }

  function formatDaysLabel(days, showPrevDay = false) {
    let base = '毎日';
    if (Array.isArray(days) && days.length > 0 && days.length < 7) {
      const order = [1, 2, 3, 4, 5, 6, 0];
      const sorted = [...days].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      base = sorted.map((d) => DAY_NAMES[d]).join('・') + '曜';
      if (showPrevDay) {
        base += ' (前日表示あり)';
      }
    }
    return base;
  }

  /**
   * 保存されている状態が、現在の表示条件に一致するか判定する
   * @param {Object|null} state - { value, forDate, phase? } 形式の状態オブジェクト
   * @param {string} match - getTaskScheduleMatch の戻り値 ('everyday' | 'today' | 'tomorrow')
   * @param {boolean} carryOverPrevDay - 前日のチェックを当日に引き継ぐか
   * @param {string} todayStr - 今日の論理日付文字列
   * @param {string} tomorrowStr - 翌日の論理日付文字列
   * @returns {'done' | 'skip' | 'todo'}
   */
  function getEffectiveTaskState(state, match, carryOverPrevDay, todayStr, tomorrowStr) {
    if (!state || !state.value || !state.forDate) {
      return 'todo';
    }

    if (match === 'today' || match === 'everyday') {
      // 「今日」「毎日」：forDate が今日で、phase がない
      if (state.forDate === todayStr && !state.phase) {
        return state.value;
      }
    } else if (match === 'tomorrow') {
      // 「明日」として表示
      if (carryOverPrevDay) {
        // 前日のチェックを当日に引き継ぐ：forDate が翌日で、phase がない
        if (state.forDate === tomorrowStr && !state.phase) {
          return state.value;
        }
      } else {
        // 前日と当日を別々に管理：forDate が翌日で、phase === 'prev'
        if (state.forDate === tomorrowStr && state.phase === 'prev') {
          return state.value;
        }
      }
    }

    return 'todo';
  }

  /**
   * 特定の子どもに対してその保育園項目がON（有効）になっているか判定する
   */
  function isNurseryTaskEnabledForChild(task, childId) {
    const child = appState.children.find((c) => c.id === childId);
    if (!child) return true;
    if (Array.isArray(child.disabledTaskIds) && child.disabledTaskIds.includes(task.id)) {
      return false;
    }
    return true;
  }

  /**
   * 特定の子どもにおける保育園項目のON/OFFを切り替える
   */
  function toggleChildTaskEnabled(childId, taskId) {
    const child = appState.children.find((c) => c.id === childId);
    if (!child) return;
    if (!Array.isArray(child.disabledTaskIds)) {
      child.disabledTaskIds = [];
    }
    const idx = child.disabledTaskIds.indexOf(taskId);
    if (idx >= 0) {
      child.disabledTaskIds.splice(idx, 1);
    } else {
      child.disabledTaskIds.push(taskId);
    }
    saveState();
    renderChildConfigSection();
    renderAll();
  }

  /**
   * おむつタスクの入力値を取得
   * @returns {{ hasInput: boolean, count: number }} - hasInput: 入力済みか、count: 枚数
   */
  function getDiaperInput(task, childId) {
    const state = task.childStates && task.childStates[String(childId)];
    if (!state || typeof state.count !== 'number') {
      return { hasInput: false, count: 0 };
    }
    return { hasInput: true, count: state.count };
  }

  /**
   * おむつタスクの枚数を設定する
   * @param {string} taskId - タスクID
   * @param {number} childId - 子どもID
   * @param {number} count - 枚数（0〜10）
   */
  function setDiaperCount(taskId, childId, count) {
    const task = appState.nurseryTasks.find((t) => t.id === taskId);
    if (!task || !task.isDiaper) return;

    if (!task.childStates) task.childStates = {};

    const now = getCurrentTime();
    const timestamp = now.getTime();

    if (count === 0) {
      // 0枚 = 自動で「不要」
      task.childStates[String(childId)] = {
        count: 0,
        inputTimestamp: timestamp,
        value: 'skip'
      };
    } else {
      // 1枚以上 = 状態を未完了にリセット
      task.childStates[String(childId)] = {
        count,
        inputTimestamp: timestamp,
        value: 'todo'
      };
    }

    saveState();
    renderAll();
  }

  /**
   * 特定の子どもにおける保育園タスクの状態 ('todo' | 'done' | 'skip') を取得
   * おむつタスクの場合は、枚数入力に基づいて特別な処理を行う
   */
  function getNurseryTaskStatusForChild(task, childId, match) {
    const state = task.childStates && task.childStates[String(childId)];

    // おむつタスクの場合
    if (task.isDiaper) {
      if (!state || typeof state.count !== 'number') {
        // 未入力
        return 'todo';
      }
      if (state.count === 0) {
        // 0枚入力 = 自動で「不要」
        return 'skip';
      }
      // 1枚以上入力 = value を返す（'done' | 'skip' | 'todo'）
      return state.value || 'todo';
    }

    // 通常のタスク
    const now = getCurrentTime();
    const todayStr = getLogicalDateString(now);
    const tomorrowStr = getNextLogicalDateString(todayStr);

    return getEffectiveTaskState(state, match, getCarryOverPrevDay(task), todayStr, tomorrowStr);
  }

  /**
   * 家事タスクの状態を取得
   */
  function getChoreTaskStatus(task, match) {
    const now = getCurrentTime();
    const todayStr = getLogicalDateString(now);
    const tomorrowStr = getNextLogicalDateString(todayStr);

    return getEffectiveTaskState(task.status, match, getCarryOverPrevDay(task), todayStr, tomorrowStr);
  }

  /**
   * 3状態サイクル（おむつ以外）：'todo'（未完了） -> 'done'（完了/やった） -> 'skip'（不要） -> 'todo'
   */
  function getNextTriState(currentStatus) {
    if (currentStatus === 'todo') return 'done';
    if (currentStatus === 'done') return 'skip';
    return 'todo';
  }

  /**
   * おむつタスクの2状態サイクル：'todo' <-> 'done'
   */
  function getNextDiaperState(currentStatus) {
    return currentStatus === 'done' ? 'todo' : 'done';
  }

  function cycleNurseryTaskState(taskId, childId, match) {
    const task = appState.nurseryTasks.find((t) => t.id === taskId);
    if (!task) return;

    // おむつタスクの場合は、入力パネルを開く処理を呼び出し元で行う
    // ここでは、入力済みの場合のみ状態を切り替える
    if (task.isDiaper) {
      const state = task.childStates && task.childStates[String(childId)];
      if (!state || typeof state.count !== 'number') {
        // 未入力の場合は何もしない（入力パネルを開く）
        return;
      }
      if (state.count === 0) {
        // 0枚の場合は常に「不要」なので切り替えない
        return;
      }
      // 1枚以上の場合は、'todo' <-> 'done' を切り替える
      const current = state.value || 'todo';
      const next = getNextDiaperState(current);
      task.childStates[String(childId)] = {
        ...state,
        value: next
      };
      saveState();
      renderAll();
      return;
    }

    // 通常のタスク
    const current = getNurseryTaskStatusForChild(task, childId, match);
    const next = getNextTriState(current);

    if (!task.childStates) task.childStates = {};

    const now = getCurrentTime();
    const todayStr = getLogicalDateString(now);
    const tomorrowStr = getNextLogicalDateString(todayStr);

    if (next === 'todo') {
      // 'todo' は保存しない
      delete task.childStates[String(childId)];
    } else {
      // forDate と phase を決定
      let forDate, phase;
      if (match === 'today' || match === 'everyday') {
        forDate = todayStr;
        phase = undefined;
      } else if (match === 'tomorrow') {
        forDate = tomorrowStr;
        phase = getCarryOverPrevDay(task) ? undefined : 'prev';
      }

      task.childStates[String(childId)] = {
        value: next,
        forDate,
        ...(phase && { phase })
      };
    }

    saveState();
    renderAll();
  }

  function cycleChoreTaskState(taskId, match) {
    const task = appState.choresTasks.find((t) => t.id === taskId);
    if (!task) return;

    const current = getChoreTaskStatus(task, match);
    const next = getNextTriState(current);

    const now = getCurrentTime();
    const todayStr = getLogicalDateString(now);
    const tomorrowStr = getNextLogicalDateString(todayStr);

    if (next === 'todo') {
      // 'todo' は保存しない
      task.status = null;
    } else {
      // forDate と phase を決定
      let forDate, phase;
      if (match === 'today' || match === 'everyday') {
        forDate = todayStr;
        phase = undefined;
      } else if (match === 'tomorrow') {
        forDate = tomorrowStr;
        phase = getCarryOverPrevDay(task) ? undefined : 'prev';
      }

      task.status = {
        value: next,
        forDate,
        ...(phase && { phase })
      };
    }

    saveState();
    renderAll();
  }

  // ==========================================================================
  // 7. 画面描画（全子ども同時表示・タスクカード・進捗バー）
  // ==========================================================================

  function renderAll() {
    const now = getCurrentTime();
    const logicalDate = getLogicalDate(now);
    const todayDay = logicalDate.getDay();
    currentRenderedDayOfWeek = todayDay;

    renderNurseryGrid(todayDay);
    renderChoresGrid(todayDay);
    updateOverallProgress(todayDay);
  }

  /**
   * 子ども人数分（1〜4人すべて）の「🎒 子どもの用意」を同時に一覧描画
   * 子ども0人の場合は保育園セクション自体を非表示にし、家庭内タスク（家事・ゴミ出し）のみを大きく表示する
   */
  function renderNurseryGrid(todayDay) {
    dom.gridNursery.innerHTML = '';

    if (appState.childCount === 0) {
      if (dom.sectionNursery) {
        dom.sectionNursery.hidden = true;
      }
      return;
    }

    if (dom.sectionNursery) {
      dom.sectionNursery.hidden = false;
    }

    const activeChildren = appState.children.slice(0, appState.childCount);

    let totalActiveAll = 0;
    let totalDoneAll = 0;
    let totalSkipAll = 0;

    activeChildren.forEach((child) => {
      const scheduledTasks = appState.nurseryTasks
        .filter((task) => isNurseryTaskEnabledForChild(task, child.id))
        .map((task) => ({ task, match: getTaskScheduleMatch(task, todayDay) }))
        .filter((item) => item.match !== null);

      let childActive = 0;
      let childDone = 0;
      let childSkip = 0;

      scheduledTasks.forEach(({ task, match }) => {
        const st = getNurseryTaskStatusForChild(task, child.id, match);
        if (st === 'skip') {
          childSkip++;
          totalSkipAll++;
        } else {
          childActive++;
          totalActiveAll++;
          if (st === 'done') {
            childDone++;
            totalDoneAll++;
          }
        }
      });

      const rowBlock = document.createElement('div');
      rowBlock.className = 'child-row-block';

      const isAllDone = childActive > 0 && childDone === childActive;
      const progressText = isAllDone ? `✓ ${childDone}/${childActive}` : `${childDone}/${childActive}`;

      const rowHeader = document.createElement('div');
      rowHeader.className = 'child-row-header';
      rowHeader.innerHTML = `
        <span class="child-row-name">👶 ${escapeHtml(child.name)}</span>
        <span class="child-row-progress${isAllDone ? ' all-done' : ''}">${escapeHtml(progressText)}</span>
      `;

      const rowTasks = document.createElement('div');
      rowTasks.className = 'child-row-tasks';

      if (scheduledTasks.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'empty-category-msg';
        emptyMsg.textContent = '対象項目なし（設定でON/OFF可）';
        rowTasks.appendChild(emptyMsg);
      } else {
        scheduledTasks.forEach(({ task, match }) => {
          const status = getNurseryTaskStatusForChild(task, child.id, match);
          const diaperInput = task.isDiaper ? getDiaperInput(task, child.id) : null;
          const card = createTaskCardElement({
            icon: task.icon,
            title: task.title,
            status,
            days: task.days,
            match,
            isDiaper: Boolean(task.isDiaper),
            diaperInput,
            hideEverydayTag: true,
            onCardClick: () => {
              // おむつで未入力の場合は入力パネルを開く
              if (task.isDiaper && !diaperInput.hasInput) {
                openDiaperInputPanel(task.id, child.id);
              } else {
                cycleNurseryTaskState(task.id, child.id, match);
              }
            },
            onDiaperInputClick: () => openDiaperInputPanel(task.id, child.id)
          });
          rowTasks.appendChild(card);
        });
      }

      rowBlock.appendChild(rowHeader);
      rowBlock.appendChild(rowTasks);
      dom.gridNursery.appendChild(rowBlock);
    });

    dom.catNurseryCount.textContent = totalSkipAll > 0
      ? `全${appState.childCount}人計: ${totalDoneAll} / ${totalActiveAll} (不要${totalSkipAll})`
      : `全${appState.childCount}人計: ${totalDoneAll} / ${totalActiveAll}`;
  }

  /**
   * 「🏠 今日の家事・ゴミ出し」グリッドを描画
   */
  function renderChoresGrid(todayDay) {
    dom.gridChores.innerHTML = '';

    const scheduledTasks = appState.choresTasks
      .map((task) => ({ task, match: getTaskScheduleMatch(task, todayDay) }))
      .filter((item) => item.match !== null);

    let activeTotal = 0;
    let doneCount = 0;
    let skipCount = 0;

    scheduledTasks.forEach(({ task, match }) => {
      const st = getChoreTaskStatus(task, match);
      if (st === 'skip') {
        skipCount++;
      } else {
        activeTotal++;
        if (st === 'done') doneCount++;
      }
    });

    dom.catChoresCount.textContent = skipCount > 0
      ? `${doneCount} / ${activeTotal} (不要${skipCount})`
      : `${doneCount} / ${activeTotal}`;

    if (scheduledTasks.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-category-msg';
      emptyMsg.textContent = '今日の該当タスクはありません';
      dom.gridChores.appendChild(emptyMsg);
      return;
    }

    scheduledTasks.forEach(({ task, match }) => {
      const status = getChoreTaskStatus(task, match);
      const card = createTaskCardElement({
        icon: task.icon,
        title: task.title,
        status,
        days: task.days,
        match,
        isDiaper: false,
        hideEverydayTag: false,
        onCardClick: () => cycleChoreTaskState(task.id, match)
      });
      dom.gridChores.appendChild(card);
    });
  }

  /**
   * 3状態（未完了・完了・不要）＋おむつ枚数入力＋前日バッジ対応の巨大ボタンカードを生成
   */
  function createTaskCardElement({
    icon,
    title,
    status,
    days,
    match,
    isDiaper,
    diaperInput, // { hasInput: boolean, count: number }
    hideEverydayTag = false,
    onCardClick,
    onDiaperInputClick
  }) {
    const stateClass = status === 'done' ? ' completed' : status === 'skip' ? ' skipped' : '';
    const card = document.createElement('div');
    card.role = 'button';
    card.tabIndex = 0;
    card.className = `task-card${stateClass}`;

    const dayTagText = formatDaysLabel(days, false);
    const showDayTag = !(hideEverydayTag && dayTagText === '毎日');

    // タイミングバッジ（ゴミ出し等の「明日（前日準備）」または「今日当日」）
    let timingBadgeHtml = '';
    if (match === 'tomorrow') {
      timingBadgeHtml = '<span class="schedule-Timing-badge schedule-timing-tomorrow">明日（前日準備）</span>';
    } else if (match === 'today') {
      timingBadgeHtml = '<span class="schedule-Timing-badge schedule-timing-today">今日</span>';
    }

    const metaRowHtml = (timingBadgeHtml || showDayTag)
      ? `<div class="task-meta-row">
          ${timingBadgeHtml}
          ${showDayTag ? `<span class="task-day-tag">${escapeHtml(dayTagText)}</span>` : ''}
        </div>`
      : '';

    // おむつ枚数入力表示
    let diaperHtml = '';
    if (isDiaper) {
      if (!diaperInput.hasInput) {
        // 未入力
        diaperHtml = `
          <div class="diaper-input-wrap diaper-not-entered" data-stop-prop="true">
            <span class="diaper-input-text">枚数を入力</span>
          </div>
        `;
      } else if (diaperInput.count === 0) {
        // 0枚入力 = 今回は不要
        diaperHtml = `
          <div class="diaper-input-wrap diaper-zero" data-stop-prop="true">
            <span class="diaper-input-text">今回は不要</span>
          </div>
        `;
      } else {
        // 1枚以上
        diaperHtml = `
          <div class="diaper-input-wrap diaper-entered" data-stop-prop="true">
            <span class="diaper-input-text">必要 ${escapeHtml(diaperInput.count)} 枚</span>
          </div>
        `;
      }
    }

    // 右側のステータス丸アイコン＆ラベル
    const circleSymbol = status === 'done' ? '✓' : status === 'skip' ? '不要' : '';
    const statusLabelText = status === 'done' ? 'やった' : status === 'skip' ? '不要' : '未完了';

    const bottomRowHtml = (diaperHtml || metaRowHtml)
      ? `<div class="task-card-bottom">
          ${diaperHtml}
          ${metaRowHtml}
        </div>`
      : '';

    card.innerHTML = `
      <div class="task-card-top">
        <span class="task-icon" aria-hidden="true">${escapeHtml(icon)}</span>
        <span class="task-title">${escapeHtml(title)}</span>
        <div class="task-status-indicator" aria-hidden="true">
          <span class="task-check-circle">${escapeHtml(circleSymbol)}</span>
          <span class="task-status-label">${escapeHtml(statusLabelText)}</span>
        </div>
      </div>
      ${bottomRowHtml}
    `;

    // おむつ枚数入力エリアのタップ処理
    if (isDiaper && onDiaperInputClick) {
      const diaperWrap = card.querySelector('.diaper-input-wrap');
      if (diaperWrap) {
        diaperWrap.addEventListener('click', (e) => {
          e.stopPropagation();
          onDiaperInputClick();
        });
      }
    }

    card.addEventListener('click', () => {
      onCardClick();
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onCardClick();
      }
    });

    return card;
  }

  /**
   * 左カラムの全体進捗（全子ども分のONになっている保育園タスク＋家事タスクの合計）を更新
   * ※「不要(skip)」にしたタスクおよび子ども別にOFFにした項目は分母から除外して計算
   */
  function updateOverallProgress(todayDay) {
    const activeChildren = appState.children.slice(0, appState.childCount);
    const scheduledNursery = appState.nurseryTasks.filter(
      (t) => getTaskScheduleMatch(t, todayDay) !== null
    );
    const scheduledChores = appState.choresTasks.filter(
      (t) => getTaskScheduleMatch(t, todayDay) !== null
    );

    let totalRequired = 0;
    let totalDone = 0;
    let totalSkipped = 0;

    // 全子どものONになっている保育園タスクを集計
    activeChildren.forEach((child) => {
      scheduledNursery.forEach((task) => {
        if (!isNurseryTaskEnabledForChild(task, child.id)) return;
        const st = getNurseryTaskStatusForChild(task, child.id);
        if (st === 'skip') {
          totalSkipped++;
        } else {
          totalRequired++;
          if (st === 'done') totalDone++;
        }
      });
    });

    // 家事・ゴミ出しタスクを集計
    scheduledChores.forEach((task) => {
      const st = task.status || 'todo';
      if (st === 'skip') {
        totalSkipped++;
      } else {
        totalRequired++;
        if (st === 'done') totalDone++;
      }
    });

    const percent = totalRequired > 0 ? Math.round((totalDone / totalRequired) * 100) : 100;

    const counterText = totalSkipped > 0
      ? `完了 ${totalDone} / ${totalRequired} (不要 ${totalSkipped})`
      : `完了 ${totalDone} / ${totalRequired}`;

    dom.progressCounter.textContent = counterText;
    if (dom.ssProgressPill) {
      dom.ssProgressPill.textContent = totalRequired > 0 && totalDone === totalRequired
        ? '🎉 今日のタスクはすべて完了！'
        : `今日のタスク ${counterText}`;
    }

    dom.progressBarFill.style.width = `${totalRequired > 0 ? percent : 0}%`;
    dom.progressBarTrack.setAttribute('aria-valuenow', String(percent));

    if (totalRequired > 0 && totalDone === totalRequired) {
      dom.celebrationBanner.hidden = false;
    } else {
      dom.celebrationBanner.hidden = true;
    }
  }

  // ==========================================================================
  // 8. 自動リセット設定＆手動リセット
  // ==========================================================================

  function toggleDateResetConfig() {
    // タップで時刻設定モーダルを表示
    openDateResetConfigModal();
  }

  function openDateResetConfigModal() {
    dom.autoResetHourInput.value = dateResetConfig.hour;
    dom.autoResetMinuteInput.value = dateResetConfig.minute;
    dom.autoResetConfigModal.hidden = false;
  }

  function closeDateResetConfigModal() {
    dom.autoResetConfigModal.hidden = true;
  }

  function saveDateResetConfigFromModal() {
    const hour = parseInt(dom.autoResetHourInput.value, 10);
    const minute = parseInt(dom.autoResetMinuteInput.value, 10);

    if (isNaN(hour) || hour < 0 || hour > 23 || isNaN(minute) || minute < 0 || minute > 59) {
      alert('有効な時刻を入力してください（時: 0-23、分: 0-59）');
      return;
    }

    dateResetConfig.hour = hour;
    dateResetConfig.minute = minute;
    saveDateResetConfig();

    updateDateResetStatusBadge();
    closeDateResetConfigModal();
  }

  function openResetModal() {
    dom.resetModal.hidden = false;
  }

  function closeResetModal() {
    dom.resetModal.hidden = true;
  }

  function executeManualReset() {
    const now = getCurrentTime();
    const todayStr = getLogicalDateString(now);
    const tomorrowStr = getNextLogicalDateString(todayStr);

    // 今日と翌日の状態を削除
    appState.nurseryTasks.forEach((task) => {
      if (task.isDiaper) {
        // おむつタスクはすべての入力値と状態を削除
        task.childStates = {};
      } else {
        // 通常タスクは forDate が今日・翌日の状態を削除
        Object.keys(task.childStates).forEach((childId) => {
          const state = task.childStates[childId];
          if (state && state.forDate && (state.forDate === todayStr || state.forDate === tomorrowStr)) {
            delete task.childStates[childId];
          }
        });
      }
    });

    appState.choresTasks.forEach((task) => {
      if (task.status && task.status.forDate && (task.status.forDate === todayStr || task.status.forDate === tomorrowStr)) {
        task.status = null;
      }
    });

    saveState();
    renderAll();
    closeResetModal();
  }

  // ==========================================================================
  // おむつ枚数入力パネル
  // ==========================================================================
  let currentDiaperTaskId = null;
  let currentDiaperChildId = null;

  function openDiaperInputPanel(taskId, childId) {
    if (!dom.diaperInputModal) return;

    currentDiaperTaskId = taskId;
    currentDiaperChildId = childId;

    const task = appState.nurseryTasks.find((t) => t.id === taskId);
    const child = appState.children.find((c) => c.id === childId);
    if (!task || !child) return;

    dom.diaperInputTitle.textContent = `${child.name} - ${task.title}`;

    // 0〜10のボタンを生成
    dom.diaperInputButtons.innerHTML = '';
    for (let i = 0; i <= 10; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'diaper-input-btn';
      btn.textContent = String(i);
      btn.dataset.count = String(i);
      btn.addEventListener('click', () => {
        setDiaperCount(taskId, childId, i);
        closeDiaperInputPanel();
      });
      dom.diaperInputButtons.appendChild(btn);
    }

    dom.diaperInputModal.hidden = false;
  }

  function closeDiaperInputPanel() {
    if (dom.diaperInputModal) {
      dom.diaperInputModal.hidden = true;
    }
    currentDiaperTaskId = null;
    currentDiaperChildId = null;
  }

  // ==========================================================================
  // 設定・タスク編集モーダル
  // ==========================================================================

  function openEditorModal() {
    renderEditorModalContents();
    dom.editorModal.hidden = false;
  }

  function closeEditorModal() {
    dom.editorModal.hidden = true;
  }

  function renderEditorModalContents() {
    renderChildConfigSection();
    renderGarbageConfigSection();
    renderDiaperReturnTimeSection();
    renderEditorTaskLists();
  }

  /**
   * 2-2. おむつの戻り時刻設定を表示
   */
  function renderDiaperReturnTimeSection() {
    if (dom.diaperReturnHourInput) {
      dom.diaperReturnHourInput.value = diaperReturnTime.hour;
    }
    if (dom.diaperReturnMinuteInput) {
      dom.diaperReturnMinuteInput.value = diaperReturnTime.minute;
    }
  }

  /**
   * 1. 子ども人数（0〜4人）ボタンと各子どもの名前・おむつ必要枚数・項目ごとON/OFF設定を描画
   */
  function renderChildConfigSection() {
    const countBtns = dom.childCountButtons.querySelectorAll('.count-btn');
    countBtns.forEach((btn) => {
      const c = Number(btn.dataset.count);
      btn.classList.toggle('active', c === appState.childCount);
    });

    dom.childrenConfigGrid.innerHTML = '';

    if (appState.childCount === 0) {
      const msg = document.createElement('div');
      msg.className = 'empty-category-msg';
      msg.style.padding = '8px 0';
      msg.textContent = '「0人 (なし)」選択中：メイン画面には「🏠 今日の家事・ゴミ出し」のみが表示されます。';
      dom.childrenConfigGrid.appendChild(msg);
      return;
    }

    const activeChildren = appState.children.slice(0, appState.childCount);

    activeChildren.forEach((child) => {
      const card = document.createElement('div');
      card.className = 'child-config-card';

      const taskPillsHtml = appState.nurseryTasks
        .map((task) => {
          const isOn = isNurseryTaskEnabledForChild(task, child.id);
          return `
            <button type="button" class="child-task-pill${isOn ? ' on' : ''}" data-task-id="${escapeHtml(task.id)}" aria-pressed="${isOn}">
              <span>${escapeHtml(task.icon)} ${escapeHtml(task.title)}</span>
              <span class="pill-state-tag">${isOn ? 'ON' : 'OFF'}</span>
            </button>
          `;
        })
        .join('');

      card.innerHTML = `
        <div class="child-config-row">
          <input type="text" class="child-name-input" value="${escapeHtml(child.name)}" maxlength="12" aria-label="子どもの名前">
        </div>
        <div class="child-tasks-toggle-section">
          <span class="child-tasks-toggle-title">表示する項目（タップでON/OFF）：</span>
          <div class="child-task-pills">${taskPillsHtml}</div>
        </div>
      `;

      const nameInput = card.querySelector('.child-name-input');
      const pillButtons = card.querySelectorAll('.child-task-pill');

      nameInput.addEventListener('input', () => {
        child.name = nameInput.value.trim() || `子ども${child.id}`;
        saveState();
        renderAll();
      });

      pillButtons.forEach((pillBtn) => {
        pillBtn.addEventListener('click', () => {
          const tId = pillBtn.dataset.taskId;
          toggleChildTaskEnabled(child.id, tId);
        });
      });

      dom.childrenConfigGrid.appendChild(card);
    });
  }

  /**
   * 2. 燃えるごみ・不燃ごみ・資源ごみの収集曜日＆「前日から表示」設定を描画
   */
  function renderGarbageConfigSection() {
    dom.garbageConfigList.innerHTML = '';

    const garbageTasks = appState.choresTasks.filter((t) => t.isGarbageConfig);

    garbageTasks.forEach((task) => {
      const row = document.createElement('div');
      row.className = 'garbage-config-item';

      const selectedDays = Array.isArray(task.days) ? task.days : [0, 1, 2, 3, 4, 5, 6];
      const dayOrder = [1, 2, 3, 4, 5, 6, 0];

      const dayChipsHtml = dayOrder
        .map((dayNum) => {
          const checked = selectedDays.includes(dayNum) ? 'checked' : '';
          return `
            <label class="day-chip">
              <input type="checkbox" value="${dayNum}" ${checked}>
              <span>${DAY_NAMES[dayNum]}</span>
            </label>
          `;
        })
        .join('');

      // 曜日が未選択の場合の注意文
      const warningHtml = selectedDays.length === 0
        ? '<p class="garbage-warning">※ すべての曜日のチェックを外すと、このタスクはメイン画面に表示されなくなります。</p>'
        : '';

      row.innerHTML = `
        <div>
          <div class="garbage-item-title">${escapeHtml(task.icon)} ${escapeHtml(task.title)}</div>
          <div class="garbage-item-controls">
            <div class="day-checkboxes">${dayChipsHtml}</div>
            <label class="prev-day-toggle-label">
              <input type="checkbox" class="garbage-prev-day-cb" ${task.showPrevDay ? 'checked' : ''}>
              <span>前日から表示</span>
            </label>
            <label class="prev-day-toggle-label">
              <input type="checkbox" class="garbage-carryover-cb" ${task.carryOverPrevDay ? 'checked' : ''}>
              <span>前日のチェックを引き継ぐ</span>
            </label>
          </div>
        </div>
        ${warningHtml}
      `;

      const checkboxes = Array.from(row.querySelectorAll('.day-checkboxes input[type="checkbox"]'));
      const prevDayCb = row.querySelector('.garbage-prev-day-cb');
      const carryOverCb = row.querySelector('.garbage-carryover-cb');

      checkboxes.forEach((cb) => {
        cb.addEventListener('change', () => {
          const chosen = checkboxes.filter((c) => c.checked).map((c) => Number(c.value));
          task.days = chosen;
          saveState();
          renderAll();
          renderEditorTaskLists();
          renderGarbageConfigSection();
        });
      });

      prevDayCb.addEventListener('change', () => {
        task.showPrevDay = prevDayCb.checked;
        saveState();
        renderAll();
        renderEditorTaskLists();
      });

      carryOverCb.addEventListener('change', () => {
        task.carryOverPrevDay = carryOverCb.checked;
        saveState();
        renderAll();
        renderEditorTaskLists();
      });

      dom.garbageConfigList.appendChild(row);
    });
  }

  /**
   * 3. 登録済みタスク一覧の描画
   */
  function renderEditorTaskLists() {
    populateEditorList(dom.editorListNursery, appState.nurseryTasks, 'nursery');
    populateEditorList(dom.editorListChores, appState.choresTasks, 'chores');
  }

  function populateEditorList(listEl, items, category) {
    listEl.innerHTML = '';
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'editor-task-item';
      li.textContent = 'タスクがありません';
      listEl.appendChild(li);
      return;
    }

    items.forEach((task) => {
      const li = document.createElement('li');
      li.className = 'editor-task-item';

      const labelDiv = document.createElement('div');
      labelDiv.className = 'editor-task-label';
      labelDiv.innerHTML = `
        <span>${escapeHtml(task.icon)}</span>
        <span>${escapeHtml(task.title)}</span>
        <span class="editor-task-days">(${escapeHtml(formatDaysLabel(task.days, task.showPrevDay))})</span>
      `;

      const controlsDiv = document.createElement('div');
      controlsDiv.className = 'editor-task-controls';

      if (task.showPrevDay) {
        const carryToggle = document.createElement('label');
        carryToggle.className = 'editor-task-toggle';
        carryToggle.innerHTML = `
          <input type="checkbox" ${task.carryOverPrevDay ? 'checked' : ''}>
          <span>前日チェック引継</span>
        `;
        const checkbox = carryToggle.querySelector('input');
        checkbox.addEventListener('change', () => {
          task.carryOverPrevDay = checkbox.checked;
          saveState();
          renderAll();
        });
        controlsDiv.appendChild(carryToggle);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'editor-delete-btn';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => {
        deleteTask(category, task.id);
      });

      li.appendChild(labelDiv);
      li.appendChild(controlsDiv);
      li.appendChild(delBtn);
      listEl.appendChild(li);
    });
  }

  function deleteTask(category, taskId) {
    if (category === 'nursery') {
      appState.nurseryTasks = appState.nurseryTasks.filter((t) => t.id !== taskId);
    } else {
      appState.choresTasks = appState.choresTasks.filter((t) => t.id !== taskId);
    }
    saveState();
    renderEditorModalContents();
    renderAll();
  }

  function handleAddTaskSubmit(event) {
    event.preventDefault();
    const icon = dom.inputTaskIcon.value.trim() || '✨';
    const title = dom.inputTaskTitle.value.trim();
    const category = dom.inputTaskCategory.value;
    const showPrevDay = dom.inputTaskShowPrevDay.checked;
    const carryOverPrevDay = dom.inputTaskCarryOver.checked;

    if (!title) return;

    const checkboxes = Array.from(dom.dayCheckboxesContainer.querySelectorAll('input[type="checkbox"]'));
    const selectedDays = checkboxes.filter((cb) => cb.checked).map((cb) => Number(cb.value));

    if (selectedDays.length === 0) {
      alert('表示する曜日を1つ以上選択してください。');
      return;
    }

    const daysValue = selectedDays.length === 7 ? 'everyday' : selectedDays;
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    if (category === 'nursery') {
      const isDiaperTask = title.includes('おむつ') || title.includes('オムツ') || icon === '🩲';
      appState.nurseryTasks.push({
        id,
        icon,
        title,
        isDiaper: isDiaperTask,
        days: daysValue,
        showPrevDay,
        carryOverPrevDay,
        childStates: {}
      });
    } else {
      const isGarbage = title.includes('ごみ') || title.includes('ゴミ');
      appState.choresTasks.push({
        id,
        icon,
        title,
        isGarbageConfig: isGarbage,
        days: daysValue,
        showPrevDay,
        carryOverPrevDay,
        status: null
      });
    }

    saveState();
    dom.inputTaskTitle.value = '';
    dom.inputTaskShowPrevDay.checked = false;
    dom.inputTaskCarryOver.checked = false;
    renderEditorModalContents();
    renderAll();
  }

  function syncEverydayPresetButton() {
    const checkboxes = Array.from(dom.dayCheckboxesContainer.querySelectorAll('input[type="checkbox"]'));
    const allChecked = checkboxes.every((cb) => cb.checked);
    dom.btnDaysEveryday.classList.toggle('active', allChecked);
  }

  // ==========================================================================
  // ユーティリティ＆イベントバインディング
  // ==========================================================================

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function bindEvents() {
    // 時計エリアタップでアナログ ⇔ デジタル切替
    dom.clockSection.addEventListener('click', toggleClockStyle);
    dom.clockSection.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleClockStyle();
      }
    });

    // 今すぐ時計全画面ボタン
    if (dom.btnFullscreenClock) {
      dom.btnFullscreenClock.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        enterScreensaver();
      });
    }

    // テーマ切替
    dom.btnThemeToggle.addEventListener('click', cycleThemeMode);

    // 自動リセット設定トグル
    if (dom.autoResetStatus) {
      dom.autoResetStatus.addEventListener('click', toggleDateResetConfig);
    }
    dom.btnCancelAutoResetConfig.addEventListener('click', closeDateResetConfigModal);
    dom.btnSaveAutoResetConfig.addEventListener('click', saveDateResetConfigFromModal);
    dom.autoResetConfigModal.addEventListener('click', (e) => {
      if (e.target === dom.autoResetConfigModal) closeDateResetConfigModal();
    });

    // 手動リセット確認モーダル
    dom.btnManualReset.addEventListener('click', openResetModal);
    dom.btnCancelReset.addEventListener('click', closeResetModal);
    dom.btnConfirmReset.addEventListener('click', executeManualReset);
    dom.resetModal.addEventListener('click', (e) => {
      if (e.target === dom.resetModal) closeResetModal();
    });

    // おむつ枚数入力パネル
    if (dom.btnCancelDiaperInput) {
      dom.btnCancelDiaperInput.addEventListener('click', closeDiaperInputPanel);
    }
    if (dom.diaperInputModal) {
      dom.diaperInputModal.addEventListener('click', (e) => {
        if (e.target === dom.diaperInputModal) closeDiaperInputPanel();
      });
    }

    // 設定・タスク編集モーダル
    dom.btnOpenEditor.addEventListener('click', openEditorModal);
    dom.btnCloseEditor.addEventListener('click', closeEditorModal);
    dom.btnDoneEditor.addEventListener('click', closeEditorModal);
    dom.editorModal.addEventListener('click', (e) => {
      if (e.target === dom.editorModal) closeEditorModal();
    });

    // 子ども人数（0〜4人）切り替えボタン
    dom.childCountButtons.addEventListener('click', (e) => {
      const btn = e.target.closest('.count-btn');
      if (!btn) return;
      const count = Number(btn.dataset.count);
      if (!Number.isNaN(count) && count >= 0 && count <= 4) {
        appState.childCount = count;
        saveState();
        renderChildConfigSection();
        renderAll();
      }
    });

    // 絵文字プリセット選択
    dom.emojiPresets.addEventListener('click', (e) => {
      const chip = e.target.closest('.emoji-chip');
      if (!chip) return;
      dom.inputTaskIcon.value = chip.dataset.emoji;
    });

    // 「毎日」ボタン
    dom.btnDaysEveryday.addEventListener('click', () => {
      const checkboxes = Array.from(dom.dayCheckboxesContainer.querySelectorAll('input[type="checkbox"]'));
      checkboxes.forEach((cb) => {
        cb.checked = true;
      });
      syncEverydayPresetButton();
    });

    dom.dayCheckboxesContainer.addEventListener('change', syncEverydayPresetButton);

    // 新規タスク追加
    dom.addTaskForm.addEventListener('submit', handleAddTaskSubmit);

    // おむつの戻り時刻保存
    if (dom.btnSaveDiaperReturnTime) {
      dom.btnSaveDiaperReturnTime.addEventListener('click', () => {
        const hour = parseInt(dom.diaperReturnHourInput.value, 10);
        const minute = parseInt(dom.diaperReturnMinuteInput.value, 10);

        if (isNaN(hour) || hour < 0 || hour > 23 || isNaN(minute) || minute < 0 || minute > 59) {
          alert('有効な時刻を入力してください（時: 0-23、分: 0-59）');
          return;
        }

        diaperReturnTime.hour = hour;
        diaperReturnTime.minute = minute;
        saveDiaperReturnTime();
        alert('おむつの戻り時刻を保存しました');
      });
    }

    // 初期サンプルデータに復元
    dom.btnRestoreDefaults.addEventListener('click', () => {
      if (confirm('すべての設定とタスクを初期サンプルデータに戻しますか？')) {
        appState = createDefaultAppState();
        saveState();
        applyClockStyleUI();
        renderEditorModalContents();
        renderAll();
      }
    });
  }

  // ==========================================================================
  // 9. 5分無操作時（または手動ボタン押下時）の全画面時計＆復帰時の誤操作防止ガード
  // ==========================================================================
  let enterGuardUntil = 0;

  function enterScreensaver() {
    if (isScreensaverActive) return;
    isScreensaverActive = true;
    clearTimeout(idleTimer);
    // 手動ボタン押下直後の指離し・遅延イベントで即解除されないよう350msガード
    enterGuardUntil = Date.now() + 350;
    if (dom.screensaverOverlay) {
      dom.screensaverOverlay.hidden = false;
    }
  }

  function wakeFromScreensaver() {
    if (!isScreensaverActive) return;
    if (Date.now() < enterGuardUntil) return;
    isScreensaverActive = false;
    // 復帰タップの直後450ms間は背後のボタン・カードへのclick等の突き抜けを完全にブロック
    wakeGuardUntil = Date.now() + 450;
    if (dom.screensaverOverlay) {
      dom.screensaverOverlay.hidden = true;
    }
    resetIdleTimer();
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!isScreensaverActive) {
      idleTimer = setTimeout(enterScreensaver, IDLE_SCREENSAVER_MS);
    }
  }

  function setupIdleScreensaver() {
    if (!dom.screensaverOverlay) return;

    // スクリーンセーバー表示中のタップ：操作画面に戻すだけで、他の一切の操作を受け付けない
    const consumeAndWake = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      wakeFromScreensaver();
    };

    dom.screensaverOverlay.addEventListener('pointerdown', consumeAndWake, { capture: true });
    dom.screensaverOverlay.addEventListener('touchstart', consumeAndWake, { capture: true, passive: false });
    dom.screensaverOverlay.addEventListener('click', consumeAndWake, { capture: true });

    // キャプチャフェーズでの誤操作防止ガード（スクリーンセーバー中、または復帰直後450ms以内のイベントを完全遮断）
    const captureGuard = (e) => {
      if (isScreensaverActive) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        wakeFromScreensaver();
        return;
      }
      if (Date.now() < wakeGuardUntil) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
      // 通常の操作時は5分無操作タイマーをリセット
      resetIdleTimer();
    };

    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'keydown'].forEach((evtName) => {
      window.addEventListener(evtName, captureGuard, { capture: true, passive: false });
    });

    resetIdleTimer();
  }

  // PWA インストールプロンプト制御（Chrome / Android / Edge 対応）
  let deferredInstallPrompt = null;

  function setupPwaInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (dom.btnInstallPwa) {
        dom.btnInstallPwa.hidden = false;
      }
    });

    if (dom.btnInstallPwa) {
      dom.btnInstallPwa.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          dom.btnInstallPwa.hidden = true;
        }
        deferredInstallPrompt = null;
      });
    }

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      if (dom.btnInstallPwa) {
        dom.btnInstallPwa.hidden = true;
      }
    });
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
          console.info('Service Worker 登録スキップ:', err);
        });
      });
    }
  }

  // ==========================================================================
  // 初期化実行
  // ==========================================================================
  function init() {
    // テストモードバッジの表示
    if (isTestMode && dom.testModeBadge) {
      dom.testModeBadge.hidden = false;
    }

    loadState();
    loadDateResetConfig();
    loadDiaperReturnTime();
    initAnalogClockFace();
    applyClockStyleUI();
    bindEvents();
    setupIdleScreensaver();
    setupPwaInstallPrompt();
    initAmbientLightSensor();
    updateClockAndSchedule();
    renderAll();
    requestWakeLock();
    registerServiceWorker();

    setInterval(updateClockAndSchedule, 1000);
  }

  init();
})();
