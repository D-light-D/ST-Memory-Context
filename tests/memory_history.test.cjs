const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MemoryHistory, prefixes } = require('../memory_history.js');

const identity = (name = 'A', owner = 'character:alice.png') => ({ owner, chatName: name, session: JSON.stringify([owner, name]) });
const messages = n => Array.from({ length: n }, (_, i) => ({ mes: `message ${i}`, is_user: i % 2 === 1 }));
const empty = () => ({ sheet: { rows: [] }, summary: [], progress: 0 });
const copy = value => JSON.parse(JSON.stringify(value));

test('delete 60 to 40 and branch at 50 replay only surviving operations after reload', () => {
    const chat = messages(60), chain = prefixes(chat);
    const journal = new MemoryHistory(identity(), empty());
    for (const [at, status] of [[20, 'healthy'], [45, 'injured'], [60, 'recovered']]) {
        journal.record({ sheet: { rows: [{ status }] }, summary: [], progress: at }, chain, at);
    }
    const disk = JSON.parse(JSON.stringify(journal.export()));
    const branch = new MemoryHistory(identity('branch'), empty(), disk, true);
    branch.reconcile(prefixes(chat.slice(0, 50)));
    assert.equal(branch.state.sheet.rows[0].status, 'injured');
    assert.equal(journal.data.entries.length, 3, 'parent is independent');
    const reloaded = new MemoryHistory(identity(), empty(), disk);
    reloaded.reconcile(prefixes(chat.slice(0, 40)));
    assert.equal(reloaded.state.sheet.rows[0].status, 'healthy');
    assert.equal(reloaded.state.progress, 20);
});

test('two chats on one card and two cards with identical chat names cannot adopt each other', () => {
    const journal = new MemoryHistory(identity(), empty());
    journal.record({ sheet: { rows: ['private'] }, summary: [], progress: 1 }, prefixes(messages(1)));
    for (const other of [identity('B'), identity('A', 'character:bob.png')]) {
        const unrelated = new MemoryHistory(other, empty(), journal.export());
        unrelated.reconcile(prefixes(messages(1)));
        assert.deepEqual(unrelated.state, empty());
    }
});

test('same-length edit and swipe invalidate dependent summaries, manual edits and progress', () => {
    const chat = messages(60), journal = new MemoryHistory(identity(), empty());
    journal.record({ sheet: { rows: ['manual'] }, summary: ['future'], progress: 60 }, prefixes(chat));
    chat[35].mes = 'edited history';
    journal.reconcile(prefixes(chat));
    assert.deepEqual(journal.state, empty());
    const other = new MemoryHistory(identity(), empty());
    other.record({ sheet: { rows: ['old swipe'] }, summary: [], progress: 60 }, prefixes(chat));
    chat[59].swipe_id = 1;
    other.reconcile(prefixes(chat));
    assert.deepEqual(other.state, empty());
});

test('generic journal patches preserve insertion, deletion, reordering, schema edits and empty state', () => {
    const chat = messages(6), chain = prefixes(chat), journal = new MemoryHistory(identity(), empty());
    const states = [
        { sheet: { rows: [{ a: 'A', b: 'B' }, { a: 'C' }] }, summary: [], progress: 1 },
        { sheet: { rows: [{ a: 'C' }, { a: 'A', b: 'B' }, { a: 'new' }] }, summary: ['first'], progress: 2 },
        { sheet: { rows: [{ a: 'C' }] }, summary: [], progress: 3 },
        { sheet: { rows: [], columns: ['new column'] }, summary: [], progress: 4 },
        empty(),
    ];
    states.forEach((state, i) => journal.record(state, chain, i + 1));
    states.forEach((state, i) => assert.deepEqual(journal.view(chain.slice(0, i + 2)), state));
});

test('visibility and inactive swipes are not content changes; active text edits are', () => {
    const chat = [{ mes: 'active', swipe_id: 0, swipes: ['active', 'other'] }];
    const before = prefixes(chat);
    chat[0].extra = { isSmallSys: true };
    chat[0].swipes.push('inactive reply');
    assert.deepEqual(prefixes(chat), before);
    chat[0].mes = 'user edited active reply';
    assert.notDeepEqual(prefixes(chat), before);
});

// Run the actual extension in an isolated ST facade. No browser, network or user data needed.
function runtime(initialContext, sharedStorage = null) {
    let context = initialContext;
    const storage = sharedStorage || {};
    Object.defineProperties(storage, {
        getItem: { configurable: true, value(key) { return this[key] ?? null; } },
        setItem: { configurable: true, value(key, value) { this[key] = String(value); } },
        removeItem: { configurable: true, value(key) { delete this[key]; } },
    });
    const noop = () => {};
    const jquery = () => ({ length: 0, on: noop, off: noop, attr: noop });
    const deferred = { done() { return this; }, fail() { return this; } };
    jquery.getScript = () => deferred;
    const sandbox = {
        console: { log: noop, warn: noop, error: noop },
        localStorage: storage, structuredClone, $: jquery,
        document: { getElementsByTagName: () => [{ getAttribute: () => '/extensions/ST-Memory-Context/index.js' }] },
        setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
        toastr: { warning: noop, success: noop, error: noop, info: noop },
        SillyTavern: { getContext: () => context },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const folder = path.resolve(__dirname, '..');
    vm.runInContext(fs.readFileSync(path.join(folder, 'index.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(folder, 'memory_history.js'), 'utf8'), sandbox);
    return { app: sandbox.Gaigai, sandbox, storage, select(next) { context = next; },
        load(name) { vm.runInContext(fs.readFileSync(path.join(folder, name), 'utf8'), sandbox); } };
}
function chatContext(chatId = 'A', chat = [], avatar = 'alice.png') {
    return { chatId, chat, characterId: 0, name2: 'Alice', characters: [{ avatar }], chatMetadata: {}, saveChat() {} };
}
function instruction(fn) { return { is_user: false, mes: `<Memory>${fn}</Memory>` }; }

test('actual extension persists memory and summary rollback, including a page reload', () => {
    const ctx = chatContext('A', [instruction('insertRow(0, {"0":"start","3":"initial"})')]);
    const first = runtime(ctx), app = first.app;
    app.m.load();
    assert.equal(app.m.s[0].r[0][3], 'initial');
    ctx.chat.push(instruction('updateRow(0, 0, {"3":"future"})'));
    app.syncMemoryHistory();
    app.m.sm.save('future summary', '0-2');
    app.config.lastSummaryIndex = 2;
    app.m.save(true, true);
    assert.equal(app.m.s[0].r[0][3], 'initial；future');
    const disk = copy(ctx.chatMetadata.gaigai);
    ctx.chatMetadata.gaigai = disk;
    const refreshed = runtime(ctx, first.storage).app;
    refreshed.m.load();
    assert.equal(refreshed.m.s[0].r[0][3], 'initial；future');
    ctx.chat.pop();
    refreshed.syncMemoryHistory();
    assert.equal(refreshed.m.s[0].r[0][3], 'initial');
    assert.equal(refreshed.m.s.at(-1).r.length, 0);
    assert.equal(refreshed.config.lastSummaryIndex, 0);
});

test('actual extension branches safely, isolates same-card chats and rejects copied unrelated journals', () => {
    const parent = chatContext('A', [instruction('insertRow(0, {"0":"parent"})')]);
    const env = runtime(parent), app = env.app;
    app.m.load();
    parent.chat.push(instruction('insertRow(0, {"0":"future"})'));
    app.syncMemoryHistory();
    const parentDisk = JSON.stringify(parent.chatMetadata.gaigai);
    const branch = chatContext('A - Branch #1', copy(parent.chat.slice(0, 1)));
    branch.chatMetadata = { main_chat: 'A', gaigai: copy(parent.chatMetadata.gaigai) };
    env.select(branch);
    app.m.load();
    assert.deepEqual(copy(app.m.s[0].r), [{ 0: 'parent' }]);
    app.m.s[0].r.push({ 0: 'branch only' });
    app.m.save(true, true);
    assert.equal(JSON.stringify(parent.chatMetadata.gaigai), parentDisk);
    const unrelated = chatContext('B', copy(parent.chat));
    unrelated.chatMetadata.gaigai = copy(parent.chatMetadata.gaigai);
    env.select(unrelated);
    app.m.load();
    assert.equal(app.m.s[0].r.some(r => r[0] === 'branch only'), false);
    // Reconstructed from B's own text, not inherited summary/manual state.
    assert.equal(app.m.s[0].r.length, 2);
    env.select(parent);
    app.m.load();
    assert.equal(app.m.s[0].r.length, 2);
    assert.equal(app.m.s[0].r.some(r => r[0] === 'branch only'), false);
});

test('actual extension guards asynchronous writes on deletion, switch, and same-name other card', () => {
    const ctx = chatContext('A', messages(3));
    const env = runtime(ctx), app = env.app;
    app.m.load();
    const token = app.captureHistoryToken();
    ctx.chat.pop();
    assert.equal(app.isHistoryTokenCurrent(token), false);
    const other = chatContext('A', messages(3), 'bob.png');
    env.select(other);
    assert.equal(app.isHistoryTokenCurrent(token), false);
    const oldId = app.m.id;
    app.m.save(true, true);
    assert.equal(other.chatMetadata.gaigai, undefined, 'old UI cannot write to new chat');
    app.m.load();
    assert.notEqual(app.m.id, oldId);
});

test('batch mode restores saved results without replaying realtime text or calling AI', () => {
    const ctx = chatContext('A', messages(3)), env = runtime(ctx), app = env.app;
    app.m.load();
    app.config_obj.autoBackfill = true;
    app.m.s[0].r.push({ 0: 'batch at 3' });
    app.config.lastBackfillIndex = 3;
    app.m.save(true, true);
    ctx.chat.push(instruction('insertRow(0, {"0":"must not execute"})'));
    app.m.s[0].r.push({ 0: 'batch at 4' });
    app.m.save(true, true);
    ctx.chat.pop();
    app.syncMemoryHistory();
    assert.deepEqual(copy(app.m.s[0].r), [{ 0: 'batch at 3' }]);
    assert.equal(app.config.lastBackfillIndex, 3);
});

test('late batch at 45 processing through 40 belongs to 40 and preserves independent later edits', () => {
    const ctx = chatContext('A', messages(45)), env = runtime(ctx), app = env.app;
    app.m.load();
    app.config_obj.autoBackfill = true;
    app.m.s[0].r.push({ 0: 'manual at 45' });
    app.m.save(true, true);
    app.commitMemoryOperation(40, () => {
        assert.equal(app.m.s[0].r.length, 0, 'operation reads source-floor state');
        app.m.s[0].ins({ 0: 'batch through 40' });
        app.config.lastBackfillIndex = 40;
    }, { type: 'backfill', start: 20, end: 40 });
    assert.deepEqual(copy(app.m.s[0].r), [{ 0: 'batch through 40' }, { 0: 'manual at 45' }]);
    ctx.chat = ctx.chat.slice(0, 42);
    app.syncMemoryHistory();
    assert.deepEqual(copy(app.m.s[0].r), [{ 0: 'batch through 40' }]);
    assert.equal(app.config.lastBackfillIndex, 40);
    ctx.chat = ctx.chat.slice(0, 39);
    app.syncMemoryHistory();
    assert.equal(app.m.s[0].r.length, 0);
});

test('summary and big-summary transactions at 40 survive branch 42 and disappear before 40', () => {
    const ctx = chatContext('A', messages(45)), env = runtime(ctx), app = env.app;
    app.m.load();
    app.commitMemoryOperation(40, () => {
        app.m.sm.save('summary through 40', '20-40');
        app.config.lastSummaryIndex = 40;
    }, { type: 'summary', start: 20, end: 40 });
    app.commitMemoryOperation(40, () => {
        app.m.s.at(-1).clear();
        app.m.sm.save('big summary through 40', '0-40');
        app.config.lastBigSummaryIndex = 40;
    }, { type: 'big-summary', start: 0, end: 40 });
    ctx.chat = ctx.chat.slice(0, 42);
    app.syncMemoryHistory();
    assert.equal(app.m.s.at(-1).r.length, 1);
    assert.equal(app.m.s.at(-1).r[0][1], 'big summary through 40');
    assert.equal(app.config.lastBigSummaryIndex, 40);
    ctx.chat = ctx.chat.slice(0, 39);
    app.syncMemoryHistory();
    assert.equal(app.m.s.at(-1).r.length, 0);
    assert.equal(app.config.lastSummaryIndex, 0);
    assert.equal(app.config.lastBigSummaryIndex, 0);
});

test('60 to 40 branch recalculates keep-10 hiding and preserves manual hides without changing history', () => {
    const ctx = chatContext('A', messages(60)), env = runtime(ctx), app = env.app;
    app.m.load();
    env.load('summary_manager.js');
    app.config_obj.contextLimit = true;
    app.config_obj.contextLimitCount = 10;
    ctx.chat[55].is_system = true; // user-owned hide outside the automatic range
    const token = app.captureHistoryToken();
    app.syncMemoryHistory();
    assert.equal(ctx.chat[0].is_system, true, 'opening message follows the same hiding rule');
    assert.equal(ctx.chat[49].is_system, true);
    assert.equal(!!ctx.chat[50].is_system, false);
    assert.equal(app.isHistoryTokenCurrent(token), true, 'hiding is not a content edit');
    const branch = chatContext('A - Branch #1', copy(ctx.chat.slice(0, 40)));
    branch.chatMetadata = { main_chat: 'A', gaigai: copy(ctx.chatMetadata.gaigai) };
    env.select(branch);
    app.m.load();
    app.syncMemoryHistory();
    assert.equal(branch.chat[29].is_system, true);
    assert.equal(branch.chat[30].is_system, false);
    assert.equal(branch.chat[39].is_system, false);
    env.select(ctx);
    app.m.load();
    app.config_obj.contextLimit = false;
    app.syncMemoryHistory();
    assert.equal(ctx.chat[0].is_system, false, 'automatic opening-message hide can be undone');
    assert.equal(ctx.chat[10].is_system, false, 'plugin hides can be undone');
    assert.equal(ctx.chat[55].is_system, true, 'manual hides remain');
});

function stubModels(env, response) {
    const app = env.app;
    app.loadConfig = async () => {};
    app.saveAllSettingsToCloud = async () => {};
    app.PromptManager = { get: () => 'test rules', resolveVariables: text => text,
        CHAT_HISTORY_END_MARKER: 'summarize now' };
    app.WI = { syncToWorldInfo: async () => {}, resetState() {} };
    app.config.useIndependentAPI = true;
    app.config_obj.contextLimit = false;
    app.tools.callIndependentAPI = async messages => response(messages);
}

test('real delayed backfill API path reads historical tables and commits at 40, not 45', async () => {
    const ctx = chatContext('A', messages(45)), env = runtime(ctx), app = env.app;
    app.m.load();
    app.config_obj.autoBackfill = true;
    app.m.s[0].ins({ 0: 'future manual row at 45' });
    app.m.save(true, true);
    env.load('backfill_manager.js');
    stubModels(env, messages => {
        assert.equal(JSON.stringify(messages).includes('future manual row at 45'), false);
        return { success: true, summary: '<Memory>insertRow(0, {"0":"batch through 40"})</Memory>' };
    });
    const result = await app.BackfillManager.handleChatBackfill(20, 40, false, -1, '', 0, false, true, true);
    assert.equal(result.success, true);
    assert.deepEqual(copy(app.m.s[0].r), [{ 0: 'batch through 40' }, { 0: 'future manual row at 45' }]);
    ctx.chat = ctx.chat.slice(0, 42);
    app.syncMemoryHistory();
    assert.deepEqual(copy(app.m.s[0].r), [{ 0: 'batch through 40' }]);
});

test('real summary and automatic big-summary paths commit their range and roll back replacement atomically', async () => {
    const ctx = chatContext('A', messages(45)), env = runtime(ctx), app = env.app;
    app.m.load();
    env.load('summary_manager.js');
    stubModels(env, () => ({ success: true, summary: '这是一段覆盖截至四十层的有效剧情总结内容。' }));
    const result = await app.SummaryManager.callAIForSummary(20, 40, 'chat', true, false, false, null, true, true);
    assert.equal(result.success, true);
    assert.equal(app.config.lastSummaryIndex, 40);
    assert.equal(app.m.s.at(-1).r.length, 1);
    app.config.summarySource = 'chat';
    await app.SummaryManager.runBigSummary(0, 40);
    assert.equal(app.config.lastBigSummaryIndex, 40);
    assert.equal(app.m.s.at(-1).r.length, 1, 'small summary is replaced, not duplicated');
    assert.equal(app.m.s.at(-1).r[0][2], '0-40');
    ctx.chat = ctx.chat.slice(0, 42);
    app.syncMemoryHistory();
    assert.equal(app.m.s.at(-1).r.length, 1);
    ctx.chat = ctx.chat.slice(0, 39);
    app.syncMemoryHistory();
    assert.equal(app.m.s.at(-1).r.length, 0);
    assert.equal(app.config.lastBigSummaryIndex, 0);
});

test('local-only storage can inherit the exact same-owner parent journal without copying another chat', () => {
    const ctx = chatContext('A', messages(45)), env = runtime(ctx), app = env.app;
    app.config_obj.cloudSync = false;
    app.m.load();
    app.commitMemoryOperation(40, () => app.m.s[0].ins({ 0: 'local batch through 40' }));
    const branch = chatContext('A - Branch #1', copy(ctx.chat.slice(0, 42)));
    branch.chatMetadata.main_chat = 'A';
    env.select(branch);
    app.m.load();
    assert.deepEqual(copy(app.m.s[0].r), [{ 0: 'local batch through 40' }]);
    const other = chatContext('A - Branch #1', copy(ctx.chat.slice(0, 42)), 'bob.png');
    other.chatMetadata.main_chat = 'A';
    env.select(other);
    app.m.load();
    assert.equal(app.m.s[0].r.length, 0);
});

test('an AI response arriving after deletion is discarded by the real backfill path', async () => {
    const ctx = chatContext('A', messages(45)), env = runtime(ctx), app = env.app;
    app.m.load();
    env.load('backfill_manager.js');
    let resolve;
    stubModels(env, () => new Promise(done => { resolve = done; }));
    const request = app.BackfillManager.handleChatBackfill(20, 40, false, -1, '', 0, false, true, true);
    ctx.chat = ctx.chat.slice(0, 30);
    app.syncMemoryHistory();
    resolve({ success: true, summary: '<Memory>insertRow(0, {"0":"stale future"})</Memory>' });
    const result = await request;
    assert.equal(result.success, false);
    assert.equal(app.m.s[0].r.length, 0);
});

test('legacy hidden prefix is adopted so an old 60-floor archive can show its last ten floors after truncation', () => {
    const ctx = chatContext('A', messages(40));
    ctx.chat.forEach(msg => { msg.is_system = true; });
    ctx.chatMetadata.gaigai = { v: 'v2.4.0', id: 'Alice_A', ts: 1,
        d: [], config: { contextLimit: true, contextLimitCount: 10 } };
    const env = runtime(ctx), app = env.app;
    env.load('summary_manager.js');
    app.m.load();
    app.syncMemoryHistory();
    assert.equal(ctx.chat[29].is_system, true);
    assert.equal(ctx.chat[30].is_system, false);
    assert.equal(ctx.chat[39].is_system, false);
    assert.equal(ctx.chat[0].is_system, true);
});

test('late historical edits keep later append operations in source-floor order', () => {
    const ctx = chatContext('A', messages(45)), env = runtime(ctx), app = env.app;
    app.m.load();
    app.commitMemoryOperation(20, () => app.m.s[0].ins({ 0: 'event', 3: 'initial' }));
    app.m.s[0].upd(0, { 3: 'future' });
    app.m.save(true, true);
    app.commitMemoryOperation(40, () => app.m.s[0].upd(0, { 3: 'historical' }));
    assert.equal(app.m.s[0].r[0][3], 'initial；historical；future');
    ctx.chat = ctx.chat.slice(0, 42);
    app.syncMemoryHistory();
    assert.equal(app.m.s[0].r[0][3], 'initial；historical');
});
