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

    const EMPTY_ROUTE = { provider: '', model: '', note: '' };

    /** One allow-list row. Three inputs plus an always-reachable remove control. */
    function RouteRow(props) {
      const route = props.route;
      const input = (key, placeholder) => h('input', {
        key,
        ...inputBase,
        value: route[key] ?? '',
        placeholder,
        onChange: (event) => props.onChange({ ...route, [key]: event.target.value }),
        onFocus: (event) => { event.currentTarget.style.borderColor = C.brand; },
        onBlur: (event) => { event.currentTarget.style.borderColor = C.border; },
        style: { ...inputBase, flex: '1 1 0', minWidth: 0 },
      });
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
          borderTop: props.first ? 'none' : `1px solid ${C.border}`,
        },
      }, [
        h('div', { key: 'p', style: { flex: '0 1 32%', minWidth: 0 } }, input('provider', 'provider')),
        h('div', { key: 'm', style: { flex: '1 1 48%', minWidth: 0 } }, input('model', 'model')),
        h('div', { key: 'n', style: { flex: '0 1 20%', minWidth: 0 } }, input('note', '备注（可选）')),
        h('button', {
          key: 'rm',
          type: 'button',
          title: '移除这条路由',
          'aria-label': '移除这条路由',
          ...press({
            onClick: props.onRemove,
            style: {
              flexShrink: 0, width: 30, height: 30, padding: 0, borderRadius: 8,
              border: `1px solid ${C.border}`, background: 'transparent',
              color: C.dim, fontSize: 16, lineHeight: 1, cursor: 'pointer',
              transition: `transform 140ms ${EASE_OUT}`, fontFamily: 'inherit',
            },
          }),
        }, '×'),
      ]);
    }

    function Page(props) {
      const form = props.ownerForm;
      const view = props.view ?? 'page';
      const [draft, setDraft] = useState(null);
      const [baseline, setBaseline] = useState(null);
      const [status, setStatus] = useState({ kind: 'idle', error: null });
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

      const routes = Array.isArray(draft.routes) ? draft.routes : [];
      const denied = Array.isArray(draft.deniedRoutes) ? draft.deniedRoutes : [];
      const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
      const update = (patch) => setDraft({ ...draft, ...patch });

      if (view === 'summary') {
        return h('span', { style: { fontSize: 12.5, color: C.dim } },
          `${routes.length} 条路由 · ${draft.replaceSubagentTool === true ? '替身模式' : '官方工具'}`);
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

        // ── allow-list ────────────────────────────────────────────────
        h('section', { key: 'official', style: card }, [
          h('p', { key: 't', style: cardTitle }, '官方白名单'),
          h('p', { key: 'd', style: cardDesc },
            'DSH 原生子智能体白名单（subagent-model-selection-settings）里的路由会自动并入生效名单，'
            + '无需在这里重复维护。'),
          h('div', { key: 'box', style: rowsBox },
            h(SwitchRow, {
              first: true,
              label: '采用官方白名单',
              hint: '每次派发时实时读取官方列表；在 DSH 设置里改了模型，这里立即跟随。',
              value: draft.useOfficialAllowList !== false,
              onChange: (value) => update({ useOfficialAllowList: value }),
            })),
        ]),

        // ── extra allow-list ──────────────────────────────────────────
        h('section', { key: 'routes', style: card }, [
          h('p', { key: 't', style: cardTitle }, '额外允许的路由'),
          h('p', { key: 'd', style: cardDesc },
            '在官方白名单之外补充放行的组合。两份名单都为空时不拦截任何路由。'),
          h('div', { key: 'box', style: rowsBox },
            routes.length === 0
              ? h('p', {
                key: 'empty',
                style: { margin: 0, padding: '16px', fontSize: 12.5, lineHeight: 1.55, color: C.dim },
              }, '还没有路由。添加第一条后，只有这里列出的组合才会被放行。')
              : routes.map((route, index) => h(RouteRow, {
                key: `r${index}`,
                first: index === 0,
                route,
                onChange: (next) => update({ routes: routes.map((r, i) => (i === index ? next : r)) }),
                onRemove: () => update({ routes: routes.filter((_, i) => i !== index) }),
              }))),
          h('button', {
            key: 'add',
            type: 'button',
            ...press({
              onClick: () => update({ routes: [...routes, { ...EMPTY_ROUTE }] }),
              style: {
                marginTop: 10, padding: '7px 14px', fontSize: 12.5, lineHeight: 1.2,
                borderRadius: 8, border: `1px dashed ${C.border}`, background: 'transparent',
                color: C.dim, cursor: 'pointer',
                transition: `transform 140ms ${EASE_OUT}`, fontFamily: 'inherit',
              },
            }),
          }, '+ 添加路由'),
        ]),

        // ── blacklist ─────────────────────────────────────────────────
        h('section', { key: 'denied', style: card }, [
          h('p', { key: 't', style: cardTitle }, '拒绝的路由'),
          h('p', { key: 'd', style: cardDesc },
            '黑名单优先于所有白名单（含官方列表）：即使某个组合被官方白名单允许，出现在这里也会被拒绝。'),
          h('div', { key: 'box', style: rowsBox },
            denied.length === 0
              ? h('p', {
                key: 'empty',
                style: { margin: 0, padding: '16px', fontSize: 12.5, lineHeight: 1.55, color: C.dim },
              }, '还没有拒绝项。这里留空表示不额外否决任何组合。')
              : denied.map((route, index) => h(RouteRow, {
                key: `d${index}`,
                first: index === 0,
                route,
                onChange: (next) => update({ deniedRoutes: denied.map((r, i) => (i === index ? next : r)) }),
                onRemove: () => update({ deniedRoutes: denied.filter((_, i) => i !== index) }),
              }))),
          h('button', {
            key: 'add',
            type: 'button',
            ...press({
              onClick: () => update({ deniedRoutes: [...denied, { ...EMPTY_ROUTE }] }),
              style: {
                marginTop: 10, padding: '7px 14px', fontSize: 12.5, lineHeight: 1.2,
                borderRadius: 8, border: `1px dashed ${C.border}`, background: 'transparent',
                color: C.dim, cursor: 'pointer',
                transition: `transform 140ms ${EASE_OUT}`, fontFamily: 'inherit',
              },
            }),
          }, '+ 添加拒绝项'),
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
              key: 'inherit',
              label: '检查继承路径',
              hint: '省略模型、回退父级时也做校验。关闭后只检查显式指定的路由。',
              value: draft.checkInherited !== false,
              onChange: (value) => update({ checkInherited: value }),
            }),
            h(SwitchRow, {
              key: 'cwd',
              label: '接受 cwd 参数',
              hint: '替身工具是否接受 cwd。关闭后子智能体一律继承父级工作目录。',
              value: draft.cwd !== false,
              onChange: (value) => update({ cwd: value }),
            }),
            h(SwitchRow, {
              key: 'listInError',
              label: '拒绝时列出可用名单',
              hint: '关闭后错误信息只说明被拒，不附带当前白名单。名单长时会淹没错误，也避免把它写进对话记录。',
              value: draft.includeAllowedListInError !== false,
              onChange: (value) => update({ includeAllowedListInError: value }),
            }),
            // ── numeric policy rows ───────────────────────────────────
            h('div', {
              key: 'depth',
              style: {
                ...rowBase, padding: '14px 16px',
                borderTop: `1px solid ${C.border}`,
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18,
              },
            }, [
              h('div', { key: 'c', style: { minWidth: 0 } }, [
                h('p', { key: 't', style: rowTitle }, '最大递归深度'),
                h('p', { key: 'd', style: rowDesc },
                  '留空表示不限。设为 1 可以禁止子智能体再派子智能体，避免无限套娃。'),
              ]),
              h('input', {
                key: 'i',
                ...inputBase,
                type: 'number', min: 1, step: 1,
                value: draft.maxDepth ?? '',
                placeholder: '不限',
                onChange: (event) => {
                  const raw = event.target.value.trim();
                  update({ maxDepth: raw === '' ? null : Number(raw) });
                },
                style: { ...inputBase, width: 110, flexShrink: 0 },
              }),
            ]),
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

        h(Footer, {
          key: 'footer',
          status,
          dirty,
          // Blank provider/model rows are dropped BEFORE the write, so an
          // unfinished row cannot fail Host validation for the whole save.
          onSave: () => {
            const cleaned = routes.filter((r) => r && r.provider && r.model);
            const cleanedDenied = denied.filter((r) => r && r.provider && r.model);
            if (cleaned.length !== routes.length || cleanedDenied.length !== denied.length) {
              const cleanedDraft = { ...draft, routes: cleaned, deniedRoutes: cleanedDenied };
              setDraft(cleanedDraft);
              commitDraft(cleanedDraft);
              return;
            }
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
