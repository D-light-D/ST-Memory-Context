/* Persistent, chat-scoped memory journal. No DOM, storage or AI calls. */
(function (root) {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value));
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    function diff(before, after, path = [], changes = []) {
        if (equal(before, after)) return changes;
        if (before && after && typeof before === 'object' && typeof after === 'object'
            && Array.isArray(before) === Array.isArray(after)) {
            for (const key of Object.keys(before)) {
                if (!(key in after)) changes.push({ path: [...path, key], remove: true });
            }
            for (const key of Object.keys(after)) diff(before[key], after[key], [...path, key], changes);
            if (Array.isArray(after) && before.length !== after.length) {
                changes.push({ path: [...path, 'length'], value: after.length });
            }
        } else changes.push({ path, value: clone(after) });
        return changes;
    }

    function applyPatch(state, changes) {
        for (const change of changes) {
            if (change.type === 'hidden') {
                const current = new Set(state.summarized[change.table] || []);
                change.remove.forEach(id => current.delete(id));
                change.add.forEach(id => current.add(id));
                state.summarized[change.table] = [...current];
                continue;
            }
            if (change.type === 'row') {
                const rows = state[change.sheet]?.r;
                const ids = state[change.ids];
                if (!rows || !ids) continue;
                const index = ids.indexOf(change.id);
                if (change.action === 'remove') {
                    if (index >= 0) { ids.splice(index, 1); rows.splice(index, 1); }
                } else if (change.action === 'update') {
                    if (index >= 0) applyPatch(rows[index], change.patch);
                } else {
                    let row = change.row;
                    if (index >= 0) { row = rows[index]; ids.splice(index, 1); rows.splice(index, 1); }
                    let target = change.before ? ids.indexOf(change.before) : ids.length;
                    if (target < 0) target = ids.length;
                    ids.splice(target, 0, change.id);
                    rows.splice(target, 0, clone(row));
                }
                continue;
            }
            // Paths are generated locally. Reject prototype mutation on imported journals as well.
            if (!change.path.length || change.path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) {
                throw new Error('Invalid memory journal path');
            }
            let target = state;
            for (const key of change.path.slice(0, -1)) target = target[key];
            const key = change.path[change.path.length - 1];
            if (change.remove) delete target[key];
            else if (change.append) target[key] = String(target[key] || '') + change.value;
            else target[key] = clone(change.value);
        }
    }

    // Stable row IDs make a late operation for floor 40 commute with independent floor-45
    // inserts/deletes. Array offsets alone would overwrite or resurrect the wrong row.
    function stateDiff(before, after) {
        if (!Object.keys(after).some(key => key.startsWith('rowIds_'))) return diff(before, after);
        const changes = [];
        const ordinaryBefore = {}, ordinaryAfter = {};
        for (const [key, value] of Object.entries(before)) {
            if (!/^(sheet_|rowIds_)\d+$/.test(key) && key !== 'summarized') ordinaryBefore[key] = value;
        }
        for (const [key, value] of Object.entries(after)) {
            if (!/^(sheet_|rowIds_)\d+$/.test(key) && key !== 'summarized') ordinaryAfter[key] = value;
        }
        changes.push(...diff(ordinaryBefore, ordinaryAfter));
        for (const table of new Set([...Object.keys(before.summarized || {}), ...Object.keys(after.summarized || {})])) {
            const oldIds = before.summarized?.[table] || [], newIds = after.summarized?.[table] || [];
            const add = newIds.filter(id => !oldIds.includes(id)), remove = oldIds.filter(id => !newIds.includes(id));
            if (add.length || remove.length) changes.push({ type: 'hidden', table, add, remove });
        }
        const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter(key => /^sheet_\d+$/.test(key)));
        for (const sheet of keys) {
            const ids = sheet.replace('sheet_', 'rowIds_');
            const oldSheet = before[sheet], newSheet = after[sheet];
            if (!newSheet) {
                changes.push({ path: [sheet], remove: true }, { path: [ids], remove: true });
                continue;
            }
            if (!oldSheet) {
                changes.push({ path: [sheet], value: { n: newSheet.n, c: newSheet.c, r: [] } }, { path: [ids], value: [] });
            } else {
                changes.push(...diff({ n: oldSheet.n, c: oldSheet.c }, { n: newSheet.n, c: newSheet.c }, [sheet]));
            }
            const oldIds = before[ids] || [], newIds = after[ids] || [];
            const working = oldIds.filter(id => newIds.includes(id));
            for (const id of oldIds) {
                if (!newIds.includes(id)) changes.push({ type: 'row', action: 'remove', sheet, ids, id });
            }
            newIds.forEach((id, i) => {
                const oldIndex = oldIds.indexOf(id), index = working.indexOf(id);
                if (index !== i) {
                    if (index >= 0) working.splice(index, 1);
                    const next = working[i] || null;
                    changes.push({ type: 'row', action: oldIndex < 0 ? 'insert' : 'move', sheet, ids, id,
                        before: next, row: newSheet.r[i] });
                    working.splice(i, 0, id);
                }
                if (oldIndex >= 0) {
                    const patch = diff(oldSheet.r[oldIndex], newSheet.r[i]);
                    for (const change of patch) {
                        if (change.path.length !== 1 || change.remove) continue;
                        const key = change.path[0], oldValue = oldSheet.r[oldIndex][key];
                        if (!String(newSheet.c[key] || '').startsWith('#') && typeof oldValue === 'string'
                            && oldValue && typeof change.value === 'string' && change.value.startsWith(oldValue + '；')) {
                            change.value = change.value.slice(oldValue.length);
                            change.append = true;
                        }
                    }
                    if (patch.length) changes.push({ type: 'row', action: 'update', sheet, ids, id, patch });
                }
            });
        }
        return changes;
    }

    // Two independent 32-bit hashes; metadata/visibility changes are deliberately excluded.
    function fingerprint(text) {
        let a = 2166136261, b = 5381;
        for (let i = 0; i < text.length; i++) {
            a = Math.imul(a ^ text.charCodeAt(i), 16777619);
            b = Math.imul(b, 33) ^ text.charCodeAt(i);
        }
        return `${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}:${text.length}`;
    }

    function prefixes(chat) {
        const result = ['root'];
        for (const msg of chat) {
            const swipe = msg.swipe_id ?? 0;
            // mes is ST's active text (including user edits); inactive swipes are not dependencies.
            const text = msg.mes ?? msg.swipes?.[swipe] ?? '';
            result.push(fingerprint(JSON.stringify([result[result.length - 1],
                !!msg.is_user, msg.role || '', msg.name || '', swipe, text])));
        }
        return result;
    }

    class MemoryHistory {
        constructor(identity, emptyState, saved = null, inherit = false) {
            this.identity = clone(identity);
            this.data = { version: 1, ...clone(identity), initial: clone(emptyState), entries: [], applied: {} };
            if (saved?.version === 1 && saved.owner === identity.owner && (saved.session === identity.session || inherit)
                && Array.isArray(saved.entries)
                && saved.initial && saved.applied && typeof saved.applied === 'object') {
                this.data = clone(saved);
                Object.assign(this.data, identity);
            }
            this.state = clone(this.data.initial);
        }

        view(chain) {
            const state = clone(this.data.initial);
            for (const entry of this.data.entries) {
                if (chain[entry.at] !== entry.prefix) continue;
                applyPatch(state, entry.patch);
            }
            return state;
        }

        reconcile(chain) {
            const oldLength = this.data.entries.length;
            const lostLegacy = this.data.entries.some(e => e.legacy && chain[e.at] !== e.prefix);
            this.data.entries = this.data.entries.filter(e => chain[e.at] === e.prefix);
            for (const [at, prefix] of Object.entries(this.data.applied)) {
                if (chain[Number(at)] !== prefix) delete this.data.applied[at];
            }
            this.state = this.view(chain);
            return { changed: oldLength !== this.data.entries.length, lostLegacy };
        }

        record(state, chain, at = chain.length - 1, legacy = false) {
            if (!Number.isInteger(at) || at < 0 || at >= chain.length) throw new Error('Invalid memory history anchor');
            const patch = stateDiff(this.state, state);
            if (patch.length) this.data.entries.push({ at, prefix: chain[at], patch, legacy });
            this.state = clone(state);
        }

        insert(state, chain, at, source = {}) {
            if (!Number.isInteger(at) || at < 0 || at >= chain.length) throw new Error('Invalid memory history anchor');
            const base = this.view(chain.slice(0, at + 1));
            const patch = stateDiff(base, state);
            if (patch.length) {
                this.data.entries.push({ at, prefix: chain[at], patch, source: clone(source) });
                // Stable sort keeps execution order for operations with the same source boundary.
                this.data.entries.sort((a, b) => a.at - b.at);
            }
            this.state = this.view(chain);
        }

        hasApplied(chain, at) { return this.data.applied[at] === chain[at]; }
        markApplied(chain, at) { this.data.applied[at] = chain[at]; }
        export() { return clone(this.data); }
    }

    const api = { MemoryHistory, prefixes, fingerprint };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else {
        root.Gaigai = root.Gaigai || {};
        root.Gaigai.History = api;
    }
})(typeof window === 'undefined' ? globalThis : window);
