window.__ModuleLoader__.load({
  id: '@local/dsh-subagent-model-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const PACKAGE = '@local/dsh-subagent-model-guard';
    const ROW_ID = 'subagent-model-guard';
    const SLOT_KEY = `${PACKAGE}#${ROW_ID}`;

    // ── design language ──────────────────────────────────────────────────
    // Card sections, a nested row container, and a footer separated from the
    // body. Matches the plugin pages this Harness already ships.
    const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      field: 'var(--dsw-alias-bg-layer-2)',
    };

    const card = {
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: '18px 20px',
      marginBottom: 14,
    };
    const cardTitle = { fontSize: 15, fontWeight: 600, margin: '0 0 6px', color: C.text };
    const cardDesc = { fontSize: 13, lineHeight: 1.55, color: C.dim, margin: '0 0 14px' };
    const rowsBox = {
      background: C.field,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      overflow: 'hidden',
    };
    const rowBase = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 18,
      padding: '14px 16px',
    };
    const rowTitle = { fontSize: 13.5, fontWeight: 600, color: C.text, margin: 0 };
    const rowDesc = { fontSize: 12.5, lineHeight: 1.5, color: C.dim, margin: '4px 0 0' };

    const inputBase = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      fontSize: 13,
      lineHeight: 1.4,
      color: C.text,
      background: 'var(--dsw-alias-bg-base, transparent)',
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      outline: 'none',
      fontFamily: 'inherit',
      transition: `border-color 140ms ${EASE_OUT}`,
    };

    const press = (extra) => ({
      ...extra,
      onPointerDown: (event) => { event.currentTarget.style.transform = 'scale(0.97)'; },
      onPointerUp: (event) => { event.currentTarget.style.transform = 'scale(1)'; },
      onPointerLeave: (event) => { event.currentTarget.style.transform = 'scale(1)'; },
    });

    /** Pill switch: white track + dark knob when on, matching the shipped pages. */
    function Switch(props) {
      const on = props.value === true;
      return h('label', {
        style: { position: 'relative', display: 'inline-flex', flexShrink: 0, cursor: 'pointer', paddingTop: 2 },
      }, [
        h('span', {
          key: 'track',
          'aria-hidden': true,
          style: {
            position: 'relative',
            width: 44,
            height: 24,
            borderRadius: 999,
            background: on ? C.text : C.border,
            transition: `background-color 160ms ${EASE_OUT}`,
          },
        }, [
          h('span', {
            key: 'knob',
            style: {
              position: 'absolute',
              top: 3,
              left: on ? 23 : 3,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: on ? 'var(--dsw-alias-bg-base, #111)' : 'var(--dsw-alias-label-secondary)',
              transition: `left 160ms ${EASE_OUT}, background-color 160ms ${EASE_OUT}`,
            },
          }),
        ]),
        h('input', {
          key: 'cb',
          type: 'checkbox',
          checked: on,
          onChange: (event) => props.onChange(event.target.checked),
          style: { position: 'absolute', opacity: 0, width: 0, height: 0 },
        }),
      ]);
    }

    /** One switch row: copy on the left, switch on the right. */
    function SwitchRow(props) {
      return h('div', { style: { ...rowBase, borderTop: props.first ? 'none' : `1px solid ${C.border}` } }, [
        h('div', { key: 'copy', style: { minWidth: 0 } }, [
          h('p', { key: 't', style: rowTitle }, props.label),
          props.hint ? h('p', { key: 'd', style: rowDesc }, props.hint) : null,
        ]),
        h(Switch, { key: 'sw', value: props.value, onChange: props.onChange }),
      ]);
    }

    /** One radio row inside a card; the whole card is the hit target. */
    function ChoiceRow(props) {
      const active = props.active;
      return h('label', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px',
          borderTop: props.first ? 'none' : `1px solid ${C.border}`,
          cursor: 'pointer',
          background: active ? 'color-mix(in srgb, ' + C.brand + ' 10%, transparent)' : 'transparent',
          transition: `background-color 140ms ${EASE_OUT}`,
        },
      }, [
        h('span', {
          key: 'dot',
          'aria-hidden': true,
          style: {
            flexShrink: 0, marginTop: 2, width: 16, height: 16, borderRadius: '50%',
            border: `1.5px solid ${active ? C.brand : C.border}`,
            display: 'grid', placeItems: 'center',
            transition: `border-color 140ms ${EASE_OUT}`,
          },
        }, active ? h('span', {
          key: 'i',
          style: { width: 8, height: 8, borderRadius: '50%', background: C.brand },
        }) : null),
        h('input', {
          key: 'r', type: 'radio', name: props.name, checked: active,
          onChange: props.onSelect, style: { position: 'absolute', opacity: 0, width: 0, height: 0 },
        }),
        h('div', { key: 'copy', style: { minWidth: 0 } }, [
          h('p', { key: 't', style: rowTitle }, props.label),
          h('p', { key: 'd', style: rowDesc }, props.hint),
        ]),
      ]);
    }

    /** Save / reset footer with inline status, separated from the body. */
    function Footer(props) {
      const status = props.status;
      const busy = status.kind === 'saving';
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 },
      }, [
        h('button', {
          key: 'save',
          type: 'button',
          ...press({
            disabled: busy || !props.dirty,
            onClick: props.onSave,
            style: {
              padding: '8px 18px', fontSize: 13, fontWeight: 500, lineHeight: 1.2,
              borderRadius: 8, border: '1px solid transparent',
              background: C.text, color: 'var(--dsw-alias-bg-base, #111)',
              cursor: props.dirty && !busy ? 'pointer' : 'default',
              opacity: props.dirty ? 1 : 0.45,
              transition: `transform 140ms ${EASE_OUT}, opacity 140ms ${EASE_OUT}`,
              fontFamily: 'inherit',
            },
          }),
        }, busy ? '保存中…' : '保存'),
        h('button', {
          key: 'reset',
          type: 'button',
          ...press({
            disabled: !props.dirty,
            onClick: props.onReset,
            style: {
              padding: '8px 14px', fontSize: 13, lineHeight: 1.2, borderRadius: 8,
              border: '1px solid transparent', background: 'transparent',
              color: C.dim, cursor: props.dirty ? 'pointer' : 'default',
              opacity: props.dirty ? 1 : 0.5,
              transition: `transform 140ms ${EASE_OUT}`, fontFamily: 'inherit',
            },
          }),
        }, '重置'),
        h('span', {
          key: 'status', role: 'status',
          style: {
            marginLeft: 'auto', fontSize: 12.5,
            color: status.kind === 'error' ? C.error : C.dim,
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, status.kind === 'error' ? (status.error ?? '保存失败') : status.kind === 'saved' ? '已保存' : ''),
      ]);
    }


    function Page(props) {
      const form = props.ownerForm;
      const view = props.view ?? 'page';
      const [draft, setDraft] = useState(null);
      const [baseline, setBaseline] = useState(null);
      const [status, setStatus] = useState({ kind: 'idle', error: null });
      const [selfcheck, setSelfcheck] = useState({ kind: 'idle', data: null, error: null });
      const [denials, setDenials] = useState({ kind: 'idle', entries: [], limit: 0, note: '', error: null });
      // `snapshot.status`: 'loading' | 'ready' | 'unavailable'. `unavailable`
      // means the Host does not expose this namespace to this client at all.
      const [sync, setSync] = useState('loading');
      const revision = useRef(undefined);

      useEffect(() => {
        if (!form) return undefined;
        if (typeof form.subscribe !== 'function') {
          // No subscription: read once, still report status.
          try {
            const snapshot = form.getSnapshot();
            revision.current = snapshot.revision;
            setSync(snapshot.status ?? 'ready');
            setDraft(snapshot.value ?? {});
            setBaseline(snapshot.value ?? {});
          } catch (error) {
            setStatus({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
          }
          return undefined;
        }
        const read = () => {
          try {
            const snapshot = form.getSnapshot();
            revision.current = snapshot.revision;
            setSync(snapshot.status ?? 'ready');
            const next = snapshot.value ?? {};
            // The Host value is always the baseline (what "dirty" compares to).
            setBaseline(next);
            // Seed the draft once; never clobber an in-progress edit. A revision
            // bump from another surface used to silently discard typed input.
            setDraft((previousDraft) => (previousDraft === null ? next : previousDraft));
          } catch (error) {
            setStatus({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
          }
        };
        read();
        return form.subscribe(read);
      }, [form]);

      if (!form) {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0' } },
          '这个插件没有可配置项。');
      }
      if (sync === 'unavailable') {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0', lineHeight: 1.6 } },
          '没有可配置项：Host 没有向本页暴露该插件的配置命名空间。',
          h('br'),
          '若刚改过插件清单，请在插件页重新启用一次，让 Host 重新投影配置。');
      }
      if (draft === null) {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0' } },
          status.kind === 'error' ? `读取配置失败：${status.error}` : '读取配置中…');
      }

      const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
      const update = (patch) => setDraft({ ...draft, ...patch });
      useEffect(() => { loadDenials(); }, []);
      // The page cannot call a tool, so it asks the read-only route the plugin
      // registers; that route runs the very same check as guard_selfcheck.
      const loadDenials = async () => {
        try {
          const response = await fetch('/plugin/subagent-model-guard/denials', { credentials: 'same-origin' });
          const data = await response.json();
          if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
          setDenials({
            kind: 'done',
            entries: Array.isArray(data?.entries) ? data.entries : [],
            limit: Number(data?.limit) || 0,
            note: typeof data?.note === 'string' ? data.note : '',
            error: null,
          });
        } catch (error) {
          setDenials({ kind: 'error', entries: [], limit: 0, note: '', error: String(error?.message ?? error) });
        }
      };
      const runSelfcheck = async () => {
        setSelfcheck({ kind: 'loading', data: null, error: null });
        try {
          const response = await fetch('/plugin/subagent-model-guard/selfcheck', { credentials: 'same-origin' });
          const data = await response.json();
          if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
          setSelfcheck({ kind: 'done', data, error: null });
        } catch (error) {
          setSelfcheck({ kind: 'error', data: null, error: String(error?.message ?? error) });
        }
      };

      if (view === 'summary') {
        return h('span', { style: { fontSize: 12.5, color: C.dim } },
          `${draft.strict !== false ? '守卫已启用' : '守卫已关闭'} · 官方名单 · ${draft.replaceSubagentTool === true ? '替身模式' : '官方工具'}`);
      }

      /**
       * Write only the fields that actually changed, as narrow `path` ops.
       * `path: []` replaces the WHOLE section and trips the Host's
       * `validatePaths` (any non-volatile key anywhere aborts the write).
       * @param target - the draft to persist (already cleaned by the caller).
       */
      const commitDraft = (target) => {
        const ops = [];
        const keys = new Set([...Object.keys(target), ...Object.keys(baseline ?? {})]);
        for (const key of keys) {
          const before = baseline?.[key];
          const after = target[key];
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          ops.push(after === undefined
            ? { op: 'unset', path: [key] }
            : { op: 'set', path: [key], value: after });
        }
        if (ops.length === 0) {
          setBaseline(target);
          setStatus({ kind: 'saved', error: null });
          return;
        }
        setStatus({ kind: 'saving', error: null });
        const settle = (error) => setStatus(error === undefined
          ? { kind: 'saved', error: null }
          : { kind: 'error', error: error instanceof Error ? error.message : String(error) });
        try {
          // `mutate` resolves to a BOOLEAN (Host acceptance), not a revision.
          const result = form.mutate(ops, revision.current);
          if (result && typeof result.then === 'function') {
            result.then(
              (answer) => {
                if (answer === false) {
                  // Revision fence or Host validation refused it. Do not claim
                  // success, and keep the draft so nothing typed is lost.
                  settle(new Error('保存被拒绝：配置已变化或字段校验未通过，请刷新后重试'));
                  return;
                }
                // Only an accepted write re-baselines what "dirty" compares to.
                setBaseline(target);
                settle(undefined);
              },
              (error) => settle(error),
            );
          } else if (result === false) {
            settle(new Error('保存被拒绝：配置已变化或字段校验未通过，请刷新后重试'));
          } else {
            setBaseline(target);
            settle(undefined);
          }
        } catch (error) {
          settle(error);
        }
      };

      return h('div', { style: { fontSize: 13, color: C.text, maxWidth: 760 } }, [
        // ── master switch first ───────────────────────────────────────
        h('section', { key: 'master', style: card }, [
          h('p', { key: 't', style: cardTitle }, '总开关'),
          h('p', { key: 'd', style: cardDesc }, '关闭后整段守卫失效，所有子智能体路由一律放行。'),
          h('div', { key: 'box', style: rowsBox },
            h(SwitchRow, {
              first: true,
              label: '启用子智能体路由守卫',
              hint: '按下面的白名单校验每一次子智能体派发。',
              value: draft.strict !== false,
              onChange: (value) => update({ strict: value }),
            })),
        ]),

        // ── the official list, which is now the only policy ───────────
        h('section', { key: 'official', style: card }, [
          h('p', { key: 't', style: cardTitle }, '放行依据：DSH 官方白名单'),
          h('p', { key: 'd', style: cardDesc },
            '本插件不再维护自己的名单。每次派发都实时读取 DSH 设置里「子智能体模型选择」的 allowedModels，'
            + '在那里改了模型，这里立即跟随，无需重载。'),
          h('div', { key: 'box', style: rowsBox },
            h('p', {
              key: 'note',
              style: { margin: 0, padding: '16px', fontSize: 12.5, lineHeight: 1.55, color: C.dim },
            }, '要增删可派发的模型，请到 DSH 官方设置里改白名单；官方列表为空时本守卫不拦截任何路由。')),
        ]),

        // ── enforcement ───────────────────────────────────────────────
        h('section', { key: 'mode', style: card }, [
          h('p', { key: 't', style: cardTitle }, '拦截方式'),
          h('p', { key: 'd', style: cardDesc }, '决定守卫在哪个环节拒绝不合规的派发。'),
          h('div', { key: 'box', style: rowsBox }, [
            ['agent-created', '创建时拦截', '在 agent/created 处校验。契约最稳，但被拒时会留下一个空会话记录。'],
            ['start-activation', '创建前拦截', '包住 subagents 服务，在 agent 构造前拒绝，不留下任何记录。依赖内部接口。'],
            ['both', '两处都拦', '同时启用上面两种，最严格，也最慢。'],
          ].map(([value, label, hint], index) => h(ChoiceRow, {
            key: value,
            first: index === 0,
            name: 'subagent-guard-enforcement',
            label,
            hint,
            active: (draft.enforcement ?? 'agent-created') === value,
            onSelect: () => update({ enforcement: value }),
          }))),
        ]),

        // ── behaviour ─────────────────────────────────────────────────
        h('section', { key: 'behaviour', style: card }, [
          h('p', { key: 't', style: cardTitle }, '行为'),
          h('p', { key: 'd', style: cardDesc }, '下面几项即时影响子智能体的派发路径。'),
          h('div', { key: 'box', style: rowsBox }, [
            h(SwitchRow, {
              key: 'replace', first: true,
              label: '替换 subagent 工具',
              hint: '用本插件的实现取代官方工具，绕开 DSH 在会话启动时冻结的模型快照，新上架的模型立即可用。',
              value: draft.replaceSubagentTool === true,
              onChange: (value) => update({ replaceSubagentTool: value }),
            }),
            h(SwitchRow, {
              key: 'audit',
              label: '每步审计',
              hint: '每一步模型调用都检查路由，只写日志、不拦截。',
              value: draft.auditEveryStep === true,
              onChange: (value) => update({ auditEveryStep: value }),
            }),
            h(SwitchRow, {
              key: 'listInError',
              label: '拒绝时列出可用名单',
              hint: '关闭后错误信息只说明被拒，不附带当前白名单。名单长时会淹没错误，也避免把它写进对话记录。',
              value: draft.includeAllowedListInError !== false,
              onChange: (value) => update({ includeAllowedListInError: value }),
            }),
            h('div', {
              key: 'dedupe',
              style: {
                ...rowBase, padding: '14px 16px',
                borderTop: `1px solid ${C.border}`,
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18,
              },
            }, [
              h('div', { key: 'c', style: { minWidth: 0 } }, [
                h('p', { key: 't', style: rowTitle }, '审计去重窗口（毫秒）'),
                h('p', { key: 'd', style: rowDesc },
                  '同一个子智能体在同一路由上重复触发审计时，窗口内只记一条。0 表示不去重。'),
              ]),
              h('input', {
                key: 'i',
                ...inputBase,
                type: 'number', min: 0, step: 500,
                value: draft.auditDedupeMs ?? 0,
                onChange: (event) => {
                  const raw = event.target.value.trim();
                  update({ auditDedupeMs: raw === '' ? 0 : Number(raw) });
                },
                style: { ...inputBase, width: 130, flexShrink: 0 },
              }),
            ]),
            h('div', {
              key: 'recentDenial',
              style: {
                ...rowBase, padding: '14px 16px',
                borderTop: `1px solid ${C.border}`,
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18,
              },
            }, [
              h('div', { key: 'c', style: { minWidth: 0 } }, [
                h('p', { key: 't', style: rowTitle }, '保留最近拒绝数'),
                h('p', { key: 'd', style: rowDesc },
                  '在内存里保留最近多少条拒绝记录，便于排查。0 表示不记录；记录只留在宿主日志，不落盘。'),
              ]),
              h('input', {
                key: 'i',
                ...inputBase,
                type: 'number', min: 0, step: 10,
                value: draft.recentDenialLimit ?? 0,
                onChange: (event) => {
                  const raw = event.target.value.trim();
                  update({ recentDenialLimit: raw === '' ? 0 : Number(raw) });
                },
                style: { ...inputBase, width: 110, flexShrink: 0 },
              }),
            ]),
          ]),
        ]),

        h('section', { key: 'selfcheck', style: card }, [
          h('p', { key: 't', style: cardTitle }, '自检'),
          h('p', { key: 'd', style: cardDesc },
            '跑一次只读检查，回答「守卫到底生效没、为什么某个路由被拒」。它不修改任何设置，'
            + '也不影响正在进行的派发。'),
          h('div', { key: 'box', style: { ...rowsBox, padding: '14px 16px' } }, [
            h('button', {
              key: 'run',
              type: 'button',
              disabled: selfcheck.kind === 'loading',
              onClick: runSelfcheck,
              style: {
                padding: '7px 14px', fontSize: 12.5, lineHeight: 1.2, borderRadius: 8,
                border: `1px solid ${C.border}`, background: 'transparent',
                color: C.text, cursor: selfcheck.kind === 'loading' ? 'default' : 'pointer',
                fontFamily: 'inherit',
              },
            }, selfcheck.kind === 'loading' ? '检查中…' : '运行自检'),
            selfcheck.kind === 'error'
              ? h('p', { key: 'e', style: { margin: '10px 0 0', fontSize: 12.5, color: C.error } },
                `自检失败：${selfcheck.error}`)
              : null,
            selfcheck.kind === 'done'
              ? h('pre', {
                key: 'out',
                style: {
                  margin: '10px 0 0', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, background: 'rgba(127,127,127,0.06)',
                  fontSize: 11.5, lineHeight: 1.5, maxHeight: 260, overflow: 'auto',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                },
              }, JSON.stringify(selfcheck.data, null, 2))
              : null,
          ]),
        ]),

        h('section', { key: 'denials', style: card }, [
          h('p', { key: 't', style: cardTitle }, '最近拒绝'),
          h('p', { key: 'd', style: cardDesc },
            '这张表回答「刚才那次派发为什么被拒」。记录只存在宿主进程内存里，'
            + '绝不落盘（原因里含模型名）；条数由设置里的「保留最近拒绝数」控制。'),
          h('div', { key: 'box', style: { ...rowsBox, padding: '14px 16px' } }, [
            h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
              h('button', {
                key: 'reload',
                type: 'button',
                onClick: loadDenials,
                style: {
                  padding: '7px 14px', fontSize: 12.5, lineHeight: 1.2, borderRadius: 8,
                  border: `1px solid ${C.border}`, background: 'transparent',
                  color: C.text, cursor: 'pointer', fontFamily: 'inherit',
                },
              }, '刷新'),
              h('span', { key: 'meta', style: { fontSize: 12, color: C.dim } },
                denials.kind === 'done'
                  ? (denials.limit > 0
                    ? `最多保留 ${denials.limit} 条 · 当前 ${denials.entries.length} 条`
                    : '未记录（保留数为 0）')
                  : ''),
            ]),
            denials.kind === 'error'
              ? h('p', { key: 'e', style: { margin: '10px 0 0', fontSize: 12.5, color: C.error } },
                `读取失败：${denials.error}`)
              : null,
            denials.kind === 'done' && denials.note !== ''
              ? h('p', { key: 'n', style: { margin: '10px 0 0', fontSize: 12.5, color: C.dim } }, denials.note)
              : null,
            denials.kind === 'done' && denials.entries.length === 0 && denials.note === ''
              ? h('p', { key: 'empty', style: { margin: '10px 0 0', fontSize: 12.5, color: C.dim } },
                '还没有拒绝记录。守卫此刻没有拦截过任何派发。')
              : null,
            denials.kind === 'done' && denials.entries.length > 0
              ? h('div', { key: 'table', style: { marginTop: 10, overflowX: 'auto' } },
                h('table', {
                  style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, color: C.text },
                }, [
                  h('thead', { key: 'h' }, h('tr', null,
                    ['时间', '类型', '父路由 → 子路由', '原因'].map((label) => h('th', {
                      key: label,
                      style: {
                        textAlign: 'left', padding: '6px 8px', whiteSpace: 'nowrap',
                        borderBottom: `1px solid ${C.border}`, color: C.dim, fontWeight: 500,
                      },
                    }, label)))),
                  h('tbody', { key: 'b' }, denials.entries.slice().reverse().map((entry, index) => h('tr', {
                    key: `${entry.at}-${index}`,
                  }, [
                    h('td', { key: 'at', style: { padding: '6px 8px', whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}` } },
                      new Date(entry.at).toLocaleTimeString()),
                    h('td', { key: 'k', style: { padding: '6px 8px', whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}`, color: entry.kind === 'denied' ? C.error : C.dim } },
                      entry.kind ?? ''),
                    h('td', { key: 'r', style: { padding: '6px 8px', borderBottom: `1px solid ${C.border}` } },
                      `${entry.parentRoute ?? '—'} → ${entry.childRoute ?? '—'}`),
                    h('td', { key: 'm', style: { padding: '6px 8px', borderBottom: `1px solid ${C.border}` } },
                      entry.reason ?? ''),
                  ]))),
                ]))
              : null,
          ]),
        ]),

        h(Footer, {
          key: 'footer',
          status,
          dirty,
          // Blank provider/model rows are dropped BEFORE the write, so an
          // unfinished row cannot fail Host validation for the whole save.
          onSave: () => {
            commitDraft(draft);
          },
          onReset: () => {
            setDraft(baseline);
            setStatus({ kind: 'idle', error: null });
          },
        }),
      ]);
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        // The Host keys a configuration form by the LOADER ENTRY id, which for
        // this bundle's `insert:` row is exactly the row id. Do NOT probe
        // `'include:' + ROW_ID` first: `configForms.get()` lazily CREATES a
        // controller for any id and never returns undefined, so a bogus
        // candidate would be cached forever and the real form never read.
        //
        // Resolved once: the controller's methods are bound to the instance, so
        // a per-render lookup would break identity.
        let ownerForm;
        try {
          ownerForm = ctx.configForms?.get?.(ROW_ID);
        } catch {
          ownerForm = undefined;
        }

        return ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: SLOT_KEY,
          locale: PACKAGE,
        }, (props) => h(Page, { ...props, ownerForm })));
      },
    };
  },
});
