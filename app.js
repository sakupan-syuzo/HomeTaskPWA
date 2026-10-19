/**
 * ファミリータスク＆置時計ボード - メインアプリケーション (app.js)
 * Google Pixel Tablet（横向き・スタンド設置）向けPWA
 *
 * 【対応機能】
 * - 保育園の用意：子ども 1〜4人 対応（タブ切替・子ども別の進捗管理）
 * - 3状態切替：「未完了 (todo)」→「完了/やった (done)」→「不要 (skip)」
 * - おむつ補充：子どもごとに「必要枚数」または「常時不要（卒おむつ等）」を設定＆カード上で直接枚数増減可能
 * - 燃えるごみ・不燃ごみ等の曜日指定＆「前日からの事前表示（明日バッジ付き）」対応
 * - 照度連動3段階ハイブリッド自動夜間モード、朝4時自動リセット、Screen Wake Lock API
 */

(() => {
  'use strict';

  // ==========================================================================
  // 定数・ストレージキー定義
  // ==========================================================================
  const STORAGE_KEYS = {
    STATE_V2: 'hometask_state_v2',
    THEME_MODE: 'hometask_theme_mode_v1',
    LAST_RESET_LOGICAL_DATE: 'hometask_last_reset_date_v1'
  };

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

  const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

  // 初期データ生成関数
  function createDefaultAppState() {
    return {
      clockStyle: 'analog', // 'analog' | 'digital' （時計エリアタップでいつでも切替可）
      childCount: 1, // 1〜4人で増減可能
      activeChildId: 1,
      children: [
        { id: 1, name: '子ども1', diaperCount: 5, diaperNotNeeded: false, disabledTaskIds: [] },
        { id: 2, name: '子ども2', diaperCount: 5, diaperNotNeeded: false, disabledTaskIds: [] },
        { id: 3, name: '子ども3', diaperCount: 4, diaperNotNeeded: false, disabledTaskIds: [] },
        { id: 4, name: '子ども4', diaperCount: 4, diaperNotNeeded: false, disabledTaskIds: [] }
      ],
      // 🎒 保育園の用意（各子どもに対して評価される項目）
      // childStates: { "1": "todo" | "done" | "skip", "2": ... }
      nurseryTasks: [
        { id: 'nursery-1', icon: '🌡️', title: '検温・連絡帳の記入', isDiaper: false, days: 'everyday', showPrevDay: false, childStates: {} },
        { id: 'nursery-2', icon: '🩲', title: 'オムツ補充', isDiaper: true, days: 'everyday', showPrevDay: false, childStates: {} },
        { id: 'nursery-3', icon: '👕', title: '着替え・エプロン', isDiaper: false, days: 'everyday', showPrevDay: false, childStates: {} },
        { id: 'nursery-4', icon: '🍼', title: '水筒の準備', isDiaper: false, days: 'everyday', showPrevDay: false, childStates: {} },
        { id: 'nursery-5', icon: '🛍️', title: '汚れ物袋', isDiaper: false, days: 'everyday', showPrevDay: false, childStates: {} }
      ],
      // 🏠 今日の家事・ゴミ出し（燃えるごみ・不燃ごみは曜日指定＆前日表示ONがデフォルト）
      // status: "todo" | "done" | "skip"
      choresTasks: [
        { id: 'garbage-burnable', icon: '🔥', title: '燃えるゴミ出し', isGarbageConfig: true, days: [2, 5], showPrevDay: true, status: 'todo' },
        { id: 'garbage-nonburnable', icon: '🥫', title: '不燃ごみ出し', isGarbageConfig: true, days: [4], showPrevDay: true, status: 'todo' },
        { id: 'garbage-resource', icon: '♻️', title: '資源ごみ', isGarbageConfig: true, days: [3], showPrevDay: true, status: 'todo' },
        { id: 'chores-3', icon: '🍽️', title: '食洗機を回す', isGarbageConfig: false, days: 'everyday', showPrevDay: false, status: 'todo' },
        { id: 'chores-4', icon: '🧺', title: '洗濯予約', isGarbageConfig: false, days: 'everyday', showPrevDay: false, status: 'todo' },
        { id: 'chores-5', icon: '🛏️', title: 'お昼寝シーツ準備', isGarbageConfig: false, days: [1], showPrevDay: true, status: 'todo' }
      ]
    };
  }

  // ==========================================================================
  // アプリケーション状態
  // ==========================================================================
  let appState = createDefaultAppState();
  let themeMode = 'auto'; // 'auto' | 'light' | 'dark'
  let currentRenderedDayOfWeek = null;

  // 照度センサー＆テーマ制御用状態
  let sensorActive = false;
  let currentLux = null;
  let sensorDarkState = null;       // null(未確定) | true(夜間) | false(昼間)
  let pendingLuxTargetState = null; // ヒステリシス待機中の遷移先状態
  let luxHysteresisTimer = null;

  // Wake Lock 状態
  let wakeLockSentinel = null;

  // ==========================================================================
  // DOM要素参照
  // ==========================================================================
  const dom = {
    html: document.documentElement,
    metaThemeColor: document.getElementById('meta-theme-color'),
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
    progressCounter: document.getElementById('progress-counter'),
    progressBarTrack: document.getElementById('progress-bar-track'),
    progressBarFill: document.getElementById('progress-bar-fill'),
    celebrationBanner: document.getElementById('celebration-banner'),
    wakelockDot: document.getElementById('wakelock-dot'),
    wakelockText: document.getElementById('wakelock-text'),
    sensorDot: document.getElementById('sensor-dot'),
    sensorText: document.getElementById('sensor-text'),
    btnThemeToggle: document.getElementById('btn-theme-toggle'),
    themeBtnIcon: document.getElementById('theme-btn-icon'),
    themeBtnLabel: document.getElementById('theme-btn-label'),
    btnManualReset: document.getElementById('btn-manual-reset'),
    btnOpenEditor: document.getElementById('btn-open-editor'),
    gridNursery: document.getElementById('grid-nursery'),
    gridChores: document.getElementById('grid-chores'),
    catNurseryCount: document.getElementById('cat-nursery-count'),
    catChoresCount: document.getElementById('cat-chores-count'),
    // リセット確認モーダル
    resetModal: document.getElementById('reset-modal'),
    btnCancelReset: document.getElementById('btn-cancel-reset'),
    btnConfirmReset: document.getElementById('btn-confirm-reset'),
    // 設定・タスク編集モーダル
    editorModal: document.getElementById('editor-modal'),
    btnCloseEditor: document.getElementById('btn-close-editor'),
    btnDoneEditor: document.getElementById('btn-done-editor'),
    btnRestoreDefaults: document.getElementById('btn-restore-defaults'),
    childCountButtons: document.getElementById('child-count-buttons'),
    childrenConfigGrid: document.getElementById('children-config-grid'),
    garbageConfigList: document.getElementById('garbage-config-list'),
    addTaskForm: document.getElementById('add-task-form'),
    inputTaskIcon: document.getElementById('input-task-icon'),
    inputTaskTitle: document.getElementById('input-task-title'),
    inputTaskCategory: document.getElementById('input-task-category'),
    inputTaskShowPrevDay: document.getElementById('input-task-show-prev-day'),
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
   * 朝4:00を1日の区切りとした「論理日付 (YYYY-MM-DD)」を返す
   */
  function getLogicalDateString(now = new Date()) {
    const shifted = new Date(now.getTime() - RESET_HOUR * 60 * 60 * 1000);
    const y = shifted.getFullYear();
    const m = String(shifted.getMonth() + 1).padStart(2, '0');
    const d = String(shifted.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * 全タスク（全子どもの保育園タスク＆家事タスク）の当日状態を「未完了(todo)」にリセット
   */
  function resetAllDailyTaskStates() {
    appState.nurseryTasks.forEach((task) => {
      task.childStates = {};
    });
    appState.choresTasks.forEach((task) => {
      task.status = 'todo';
    });
    saveState();
  }

  /**
   * 朝4:00を跨いでいた場合、全タスクの完了/不要状態をリセットする
   */
  function checkAndPerformAutoReset(now = new Date()) {
    const currentLogicalDate = getLogicalDateString(now);
    const lastResetDate = localStorage.getItem(STORAGE_KEYS.LAST_RESET_LOGICAL_DATE);

    if (!lastResetDate) {
      localStorage.setItem(STORAGE_KEYS.LAST_RESET_LOGICAL_DATE, currentLogicalDate);
      return false;
    }

    if (lastResetDate !== currentLogicalDate) {
      resetAllDailyTaskStates();
      localStorage.setItem(STORAGE_KEYS.LAST_RESET_LOGICAL_DATE, currentLogicalDate);
      renderAll();
      return true;
    }
    return false;
  }

  // ==========================================================================
  // 2. LocalStorage データの読み込み・保存
  // ==========================================================================

  function loadState() {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME_MODE);
    if (savedTheme === 'auto' || savedTheme === 'light' || savedTheme === 'dark') {
      themeMode = savedTheme;
    }

    const rawState = localStorage.getItem(STORAGE_KEYS.STATE_V2);
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
          if (appState.activeChildId > appState.childCount) {
            appState.activeChildId = 1;
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

    checkAndPerformAutoReset(new Date());
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEYS.STATE_V2, JSON.stringify(appState));
    } catch (e) {
      console.error('状態の保存に失敗しました:', e);
    }
  }

  function saveThemeMode() {
    try {
      localStorage.setItem(STORAGE_KEYS.THEME_MODE, themeMode);
    } catch (e) {
      console.error('テーマ設定の保存に失敗しました:', e);
    }
  }

  // ==========================================================================
  // 3. 時計（アナログSVG文字盤＆デジタル）・日付・定期チェック処理
  // ==========================================================================

  /**
   * アナログ時計の60分目盛りと1〜12の数字をSVG上に生成する
   */
  function initAnalogClockFace() {
    if (!dom.analogTicks || !dom.analogNumbers) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    const cx = 130;
    const cy = 130;

    dom.analogTicks.innerHTML = '';
    dom.analogNumbers.innerHTML = '';

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
      dom.analogTicks.appendChild(line);
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
      dom.analogNumbers.appendChild(text);
    }
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
    const now = new Date();

    const h = now.getHours();
    const m = now.getMinutes();
    const s = now.getSeconds();

    const hours = String(h).padStart(2, '0');
    const minutes = String(m).padStart(2, '0');
    const seconds = String(s).padStart(2, '0');

    dom.clockHm.textContent = `${hours}:${minutes}`;
    dom.clockSec.textContent = seconds;

    // アナログ時計の針の角度を更新
    const secDeg = s * 6;
    const minDeg = m * 6 + s * 0.1;
    const hourDeg = (h % 12) * 30 + m * 0.5;

    if (dom.analogHourHand) {
      dom.analogHourHand.setAttribute('transform', `rotate(${hourDeg} 130 130)`);
      dom.analogMinHand.setAttribute('transform', `rotate(${minDeg} 130 130)`);
      dom.analogSecHand.setAttribute('transform', `rotate(${secDeg} 130 130)`);
    }

    const month = now.getMonth() + 1;
    const date = now.getDate();
    const dayOfWeek = now.getDay();
    dom.dateDisplay.textContent = `${month}月${date}日 (${DAY_NAMES[dayOfWeek]})`;

    // 朝4:00の自動リセット判定
    checkAndPerformAutoReset(now);

    // 曜日が変わった場合はタスク一覧を再描画
    if (currentRenderedDayOfWeek !== dayOfWeek) {
      currentRenderedDayOfWeek = dayOfWeek;
      renderAll();
    }

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

  const osDarkMediaQuery = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : { matches: false, addEventListener: () => {} };

  function initAmbientLightSensor() {
    if (!('AmbientLightSensor' in window)) {
      sensorActive = false;
      updateSensorStatusBadge();
      return;
    }

    try {
      const sensor = new window.AmbientLightSensor({ frequency: 1 });

      sensor.addEventListener('reading', () => {
        sensorActive = true;
        currentLux = Math.round(sensor.illuminance);

        if (sensorDarkState === null) {
          sensorDarkState = currentLux < LUX_CONFIG.DARK_THRESHOLD;
          evaluateAndApplyTheme();
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
                evaluateAndApplyTheme();
                updateSensorStatusBadge();
              }, LUX_CONFIG.HOLD_DURATION_MS);
            }
          } else if (luxHysteresisTimer) {
            clearTimeout(luxHysteresisTimer);
            luxHysteresisTimer = null;
            pendingLuxTargetState = null;
          }
        }

        updateSensorStatusBadge();
      });

      sensor.addEventListener('error', () => {
        sensorActive = false;
        currentLux = null;
        updateSensorStatusBadge();
        evaluateAndApplyTheme();
      });

      sensor.start();
    } catch (err) {
      sensorActive = false;
      currentLux = null;
      updateSensorStatusBadge();
    }
  }

  function evaluateAndApplyTheme(now = new Date()) {
    let resolvedTheme = 'light';

    if (themeMode === 'light') {
      resolvedTheme = 'light';
    } else if (themeMode === 'dark') {
      resolvedTheme = 'dark';
    } else {
      const inNightWindow = isNightTimeWindow(now);
      if (sensorActive && sensorDarkState !== null) {
        resolvedTheme = (sensorDarkState || inNightWindow) ? 'dark' : 'light';
      } else {
        resolvedTheme = (osDarkMediaQuery.matches || inNightWindow) ? 'dark' : 'light';
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

  function updateSensorStatusBadge(now = new Date()) {
    if (sensorActive && currentLux !== null) {
      dom.sensorDot.className = 'status-dot active';
      const luxModeLabel = sensorDarkState ? '暗室' : '明室';
      dom.sensorText.textContent = `照度: ${currentLux} lx (${luxModeLabel})`;
    } else {
      dom.sensorDot.className = 'status-dot warn';
      const inNight = isNightTimeWindow(now);
      const osDark = osDarkMediaQuery.matches;
      if (inNight) {
        dom.sensorText.textContent = '自動判定: 夜間時間帯 (21-6時)';
      } else if (osDark) {
        dom.sensorText.textContent = '自動判定: OSダーク連動';
      } else {
        dom.sensorText.textContent = '自動判定: OS/時間帯連動';
      }
    }
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
    evaluateAndApplyTheme();
  }

  if (osDarkMediaQuery.addEventListener) {
    osDarkMediaQuery.addEventListener('change', () => {
      evaluateAndApplyTheme();
    });
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
      checkAndPerformAutoReset(new Date());
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
   * 特定の子どもにおける保育園タスクの状態 ('todo' | 'done' | 'skip') を取得
   * おむつタスクでその子どもが「おむつ常時不要 (diaperNotNeeded)」の場合は自動的に 'skip' とする
   */
  function getNurseryTaskStatusForChild(task, childId) {
    const child = appState.children.find((c) => c.id === childId);
    if (task.isDiaper && child && child.diaperNotNeeded) {
      return 'skip';
    }
    const st = task.childStates && task.childStates[String(childId)];
    if (st === 'done' || st === 'skip') return st;
    return 'todo';
  }

  /**
   * 3状態サイクル：'todo'（未完了） -> 'done'（完了/やった） -> 'skip'（不要） -> 'todo'
   */
  function getNextTriState(currentStatus) {
    if (currentStatus === 'todo') return 'done';
    if (currentStatus === 'done') return 'skip';
    return 'todo';
  }

  function cycleNurseryTaskState(taskId, childId) {
    const task = appState.nurseryTasks.find((t) => t.id === taskId);
    if (!task) return;
    const child = appState.children.find((c) => c.id === childId);

    const current = getNurseryTaskStatusForChild(task, childId);
    const next = getNextTriState(current);

    // おむつが「常時不要」に設定されていた子どもをタップで切り替えた場合は常時不要フラグを解除して状態変更を反映
    if (task.isDiaper && child && child.diaperNotNeeded && next !== 'skip') {
      child.diaperNotNeeded = false;
    }

    if (!task.childStates) task.childStates = {};
    task.childStates[String(childId)] = next;

    saveState();
    renderAll();
  }

  function cycleChoreTaskState(taskId) {
    const task = appState.choresTasks.find((t) => t.id === taskId);
    if (!task) return;
    task.status = getNextTriState(task.status || 'todo');
    saveState();
    renderAll();
  }

  function adjustChildDiaperCount(childId, delta) {
    const child = appState.children.find((c) => c.id === childId);
    if (!child) return;
    const nextCount = Math.max(0, Math.min(20, (child.diaperCount || 0) + delta));
    child.diaperCount = nextCount;
    if (nextCount === 0) {
      child.diaperNotNeeded = true;
    } else {
      child.diaperNotNeeded = false;
    }
    saveState();
    renderAll();
  }

  // ==========================================================================
  // 7. 画面描画（全子ども同時表示・タスクカード・進捗バー）
  // ==========================================================================

  function renderAll() {
    const todayDay = new Date().getDay();
    currentRenderedDayOfWeek = todayDay;

    renderNurseryGrid(todayDay);
    renderChoresGrid(todayDay);
    updateOverallProgress(todayDay);
  }

  /**
   * 子ども人数分（1〜4人すべて）の「🎒 保育園の用意」を同時に一覧描画
   */
  function renderNurseryGrid(todayDay) {
    dom.gridNursery.innerHTML = '';
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

      scheduledTasks.forEach(({ task }) => {
        const st = getNurseryTaskStatusForChild(task, child.id);
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
          const status = getNurseryTaskStatusForChild(task, child.id);
          const card = createTaskCardElement({
            icon: task.icon,
            title: task.title,
            status,
            days: task.days,
            match,
            isDiaper: Boolean(task.isDiaper),
            diaperCount: child.diaperCount,
            diaperNotNeeded: child.diaperNotNeeded,
            hideEverydayTag: true,
            onCardClick: () => cycleNurseryTaskState(task.id, child.id),
            onDiaperStep: (delta) => adjustChildDiaperCount(child.id, delta)
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

    scheduledTasks.forEach(({ task }) => {
      const st = task.status || 'todo';
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
      const status = task.status || 'todo';
      const card = createTaskCardElement({
        icon: task.icon,
        title: task.title,
        status,
        days: task.days,
        match,
        isDiaper: false,
        hideEverydayTag: false,
        onCardClick: () => cycleChoreTaskState(task.id)
      });
      dom.gridChores.appendChild(card);
    });
  }

  /**
   * 3状態（未完了・完了・不要）＋おむつ枚数ステッパー＋前日バッジ対応の巨大ボタンカードを生成
   */
  function createTaskCardElement({
    icon,
    title,
    status,
    days,
    match,
    isDiaper,
    diaperCount,
    diaperNotNeeded,
    hideEverydayTag = false,
    onCardClick,
    onDiaperStep
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

    // おむつ必要枚数コントロール
    let diaperHtml = '';
    if (isDiaper) {
      if (status === 'skip' || diaperNotNeeded || diaperCount === 0) {
        diaperHtml = `
          <div class="diaper-Counter-wrap" data-stop-prop="true">
            <span class="diaper-count-text">おむつ不要</span>
            <button type="button" class="diaper-step-btn" data-delta="1" title="枚数を増やす">＋</button>
          </div>
        `;
      } else {
        diaperHtml = `
          <div class="diaper-Counter-wrap" data-stop-prop="true">
            <button type="button" class="diaper-step-btn" data-delta="-1" title="1枚減らす">−</button>
            <span class="diaper-count-text">必要 ${escapeHtml(diaperCount)} 枚</span>
            <button type="button" class="diaper-step-btn" data-delta="1" title="1枚増やす">＋</button>
          </div>
        `;
      }
    }

    // 右側のステータス丸アイコン＆ラベル
    const circleSymbol = status === 'done' ? '✓' : status === 'skip' ? '不要' : '';
    const statusLabelText = status === 'done' ? 'やった' : status === 'skip' ? '不要' : '未完了';

    card.innerHTML = `
      <span class="task-icon" aria-hidden="true">${escapeHtml(icon)}</span>
      <div class="task-info">
        <div class="task-title-row">
          <span class="task-title">${escapeHtml(title)}</span>
        </div>
        ${diaperHtml}
        ${metaRowHtml}
      </div>
      <div class="task-status-indicator" aria-hidden="true">
        <span class="task-check-circle">${escapeHtml(circleSymbol)}</span>
        <span class="task-status-label">${escapeHtml(statusLabelText)}</span>
      </div>
    `;

    // おむつ枚数の「−」「＋」ボタンタップ時はカードの状態切替を発火させない
    if (isDiaper && onDiaperStep) {
      const stepBtns = card.querySelectorAll('.diaper-step-btn');
      stepBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const delta = Number(btn.dataset.delta);
          onDiaperStep(delta);
        });
      });
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

    dom.progressCounter.textContent = totalSkipped > 0
      ? `完了 ${totalDone} / ${totalRequired} (不要 ${totalSkipped})`
      : `完了 ${totalDone} / ${totalRequired}`;

    dom.progressBarFill.style.width = `${totalRequired > 0 ? percent : 0}%`;
    dom.progressBarTrack.setAttribute('aria-valuenow', String(percent));

    if (totalRequired > 0 && totalDone === totalRequired) {
      dom.celebrationBanner.hidden = false;
    } else {
      dom.celebrationBanner.hidden = true;
    }
  }

  // ==========================================================================
  // 8. 設定・タスク編集モーダル（子ども1〜4人・項目別ON/OFF・おむつ枚数・ゴミ曜日）
  // ==========================================================================

  function openResetModal() {
    dom.resetModal.hidden = false;
  }

  function closeResetModal() {
    dom.resetModal.hidden = true;
  }

  function executeManualReset() {
    resetAllDailyTaskStates();
    localStorage.setItem(STORAGE_KEYS.LAST_RESET_LOGICAL_DATE, getLogicalDateString(new Date()));
    renderAll();
    closeResetModal();
  }

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
    renderEditorTaskLists();
  }

  /**
   * 1. 子ども人数（1〜4人）ボタンと各子どもの名前・おむつ必要枚数・項目ごとON/OFF設定を描画
   */
  function renderChildConfigSection() {
    const countBtns = dom.childCountButtons.querySelectorAll('.count-btn');
    countBtns.forEach((btn) => {
      const c = Number(btn.dataset.count);
      btn.classList.toggle('active', c === appState.childCount);
    });

    dom.childrenConfigGrid.innerHTML = '';
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
        <div class="child-config-row">
          <span>🩲 おむつ必要枚数</span>
          <div class="diaper-config-controls">
            <input type="number" class="diaper-number-input" min="0" max="20" value="${escapeHtml(child.diaperCount)}" ${child.diaperNotNeeded ? 'disabled' : ''}>
            <span>枚</span>
          </div>
        </div>
        <div class="child-tasks-toggle-section">
          <span class="child-tasks-toggle-title">表示する項目（タップでON/OFF）：</span>
          <div class="child-task-pills">${taskPillsHtml}</div>
        </div>
      `;

      const nameInput = card.querySelector('.child-name-input');
      const diaperInput = card.querySelector('.diaper-number-input');
      const pillButtons = card.querySelectorAll('.child-task-pill');

      nameInput.addEventListener('input', () => {
        child.name = nameInput.value.trim() || `子ども${child.id}`;
        saveState();
        renderAll();
      });

      diaperInput.addEventListener('change', () => {
        const val = Math.max(0, Math.min(20, Number(diaperInput.value) || 0));
        diaperInput.value = String(val);
        child.diaperCount = val;
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

      row.innerHTML = `
        <div class="garbage-item-title">${escapeHtml(task.icon)} ${escapeHtml(task.title)}</div>
        <div class="garbage-item-controls">
          <div class="day-checkboxes">${dayChipsHtml}</div>
          <label class="prev-day-toggle-label">
            <input type="checkbox" class="garbage-prev-day-cb" ${task.showPrevDay ? 'checked' : ''}>
            <span>前日から表示</span>
          </label>
        </div>
      `;

      const checkboxes = Array.from(row.querySelectorAll('.day-checkboxes input[type="checkbox"]'));
      const prevDayCb = row.querySelector('.garbage-prev-day-cb');

      checkboxes.forEach((cb) => {
        cb.addEventListener('change', () => {
          const chosen = checkboxes.filter((c) => c.checked).map((c) => Number(c.value));
          task.days = chosen;
          saveState();
          renderAll();
          renderEditorTaskLists();
        });
      });

      prevDayCb.addEventListener('change', () => {
        task.showPrevDay = prevDayCb.checked;
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

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'editor-delete-btn';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => {
        deleteTask(category, task.id);
      });

      li.appendChild(labelDiv);
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
        status: 'todo'
      });
    }

    saveState();
    dom.inputTaskTitle.value = '';
    dom.inputTaskShowPrevDay.checked = false;
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

    // テーマ切替
    dom.btnThemeToggle.addEventListener('click', cycleThemeMode);

    // 手動リセット確認モーダル
    dom.btnManualReset.addEventListener('click', openResetModal);
    dom.btnCancelReset.addEventListener('click', closeResetModal);
    dom.btnConfirmReset.addEventListener('click', executeManualReset);
    dom.resetModal.addEventListener('click', (e) => {
      if (e.target === dom.resetModal) closeResetModal();
    });

    // 設定・タスク編集モーダル
    dom.btnOpenEditor.addEventListener('click', openEditorModal);
    dom.btnCloseEditor.addEventListener('click', closeEditorModal);
    dom.btnDoneEditor.addEventListener('click', closeEditorModal);
    dom.editorModal.addEventListener('click', (e) => {
      if (e.target === dom.editorModal) closeEditorModal();
    });

    // 子ども人数（1〜4人）切り替えボタン
    dom.childCountButtons.addEventListener('click', (e) => {
      const btn = e.target.closest('.count-btn');
      if (!btn) return;
      const count = Number(btn.dataset.count);
      if (count >= 1 && count <= 4) {
        appState.childCount = count;
        if (appState.activeChildId > count) {
          appState.activeChildId = 1;
        }
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
    loadState();
    initAnalogClockFace();
    applyClockStyleUI();
    bindEvents();
    initAmbientLightSensor();
    updateClockAndSchedule();
    renderAll();
    requestWakeLock();
    registerServiceWorker();

    setInterval(updateClockAndSchedule, 1000);
  }

  init();
})();
