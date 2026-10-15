window.__ModuleLoader__.load({
  id: "deepseek-harness-codex-auth",
  factory: (require) => {
    const module = { exports: {} }
    const React = require("react")
    const { jsx, jsxs } = require("react/jsx-runtime")

    const inject = ["slots", "configForms"]
    const fieldStyle = { display: "flex", flexDirection: "column", gap: 6, padding: "2px 0 10px" }
    const rowStyle = { display: "flex", gap: 8 }
    const inputStyle = { flex: 1, minWidth: 0, height: 32, border: ".5px solid var(--dsw-alias-border-l4)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", padding: "0 10px", font: "inherit" }
    const buttonStyle = { height: 32, border: ".5px solid var(--dsw-alias-border-l3)", borderRadius: "var(--dsw-radius-md)", background: "transparent", color: "var(--dsw-alias-label-primary)", padding: "0 12px", cursor: "pointer" }
    const smallButtonStyle = { ...buttonStyle, flexShrink: 0, height: 24, fontSize: 11, padding: "0 8px" }
    const tagStyle = { flexShrink: 0, padding: "1px 6px", borderRadius: 999, border: ".5px solid var(--dsw-alias-border-l4)", color: "var(--dsw-alias-label-secondary)", fontSize: 10, lineHeight: "16px" }

    const QUOTA_ROUTE = "/api/codex-pool"
    const POLL_INTERVAL_MS = 15_000
    const STRATEGY_LABEL = { hybrid: "智能选择", "round-robin": "轮询", sticky: "固定账号" }
    const STATE_COLOR = {
      ok: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      spent: "var(--dsw-alias-state-error-primary)",
      idle: "var(--dsw-alias-state-idle-primary)"
    }

    function validProxyUrl(value) {
      if (!value) return true
      try {
        return ["http:", "https:"].includes(new URL(value).protocol)
      } catch {
        return false
      }
    }

    function ProxyField({ provider, form }) {
      if (provider.provider !== "openai-codex") return null
      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
      )
      const saved = snapshot.value?.providers?.[provider.provider]?.proxyUrl ?? ""
      const [value, setValue] = React.useState(saved)
      const [state, setState] = React.useState("idle")
      React.useEffect(() => setValue(saved), [saved])
      const normalized = value.trim()
      const valid = validProxyUrl(normalized)

      async function save(event) {
        event.preventDefault()
        if (!valid || state === "saving") return
        setState("saving")
        const path = ["providers", provider.provider, "proxyUrl"]
        const ok = await form.mutate([normalized ? { op: "set", path, value: normalized } : { op: "unset", path }])
        setState(ok ? "saved" : "failed")
      }

      return jsxs("form", { onSubmit: save, style: fieldStyle, children: [
        jsx("label", { htmlFor: "codex-proxy-url", style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, fontWeight: 500 }, children: "网络代理" }),
        jsxs("div", { style: rowStyle, children: [
          jsx("input", { id: "codex-proxy-url", value, onChange: (event) => { setValue(event.target.value); setState("idle") }, placeholder: "例如 http://127.0.0.1:7890；留空为直连", disabled: snapshot.status !== "ready" || !snapshot.writable || state === "saving", "aria-invalid": !valid, style: inputStyle }),
          jsx("button", { type: "submit", disabled: !valid || normalized === saved || state === "saving", style: buttonStyle, children: state === "saving" ? "保存中" : "保存代理" }),
        ] }),
        !valid ? jsx("span", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 }, children: "请输入 HTTP 或 HTTPS 代理地址" }) : null,
        state === "saved" ? jsx("span", { role: "status", style: { color: "var(--dsw-alias-state-success-primary)", fontSize: 12 }, children: "代理已保存，重启 DSH 后生效" }) : null,
        state === "failed" ? jsx("span", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 }, children: "代理保存失败" }) : null,
      ] })
    }

    /** Poll the host's pool snapshot on the origin the settings page is served from. */
    function usePool() {
      const [state, setState] = React.useState({ status: "loading" })
      React.useEffect(() => {
        let live = true
        let timer
        async function load() {
          try {
            const response = await fetch(QUOTA_ROUTE, { headers: { accept: "application/json" } })
            if (!response.ok) throw new Error(String(response.status))
            const snapshot = await response.json()
            if (live) setState({ status: "ready", snapshot })
          } catch {
            // Keep the last good reading on screen; only the badge goes stale.
            if (live) setState((previous) => ({ status: "offline", snapshot: previous.snapshot }))
          }
        }
        /**
         * Opening the panel is the refresh trigger: ask the host to re-read the
         * accounts now rather than waiting out the poll or the next model request,
         * so the numbers shown are the ones this panel was opened to see.
         */
        async function refresh() {
          try {
            const response = await fetch(QUOTA_ROUTE, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ refresh: true })
            })
            if (!response.ok) throw new Error(String(response.status))
            const snapshot = await response.json()
            if (live) setState({ status: "ready", snapshot })
          } catch {
            // A refresh that cannot run never blanks a panel that already has data.
          }
        }
        load()
        refresh()
        timer = setInterval(load, POLL_INTERVAL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [])
      // A pin request answers with the state it produced, so the panel can show
      // the switch at once instead of waiting out the poll interval.
      return { ...state, apply: (snapshot) => setState({ status: "ready", snapshot }) }
    }

    function resetLabel(at, now) {
      if (typeof at !== "number" || !Number.isFinite(at)) return undefined
      const minutes = Math.round((at - now) / 60_000)
      if (minutes <= 0) return "即将重置"
      if (minutes < 60) return `${minutes} 分钟后重置`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} 小时后重置`
      return `${Math.round(hours / 24)} 天后重置`
    }

    function sinceLabel(at, now) {
      if (typeof at !== "number" || !Number.isFinite(at)) return undefined
      const seconds = Math.round((now - at) / 1000)
      if (seconds < 60) return "刚刚"
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.round(hours / 24)} 天前`
    }

    /**
     * The snapshot reports consumption, but the panel shows what is left. Turning
     * "0% used" into "100% remaining" is also what makes a window that exists but
     * has not been touched distinguishable from one the account does not have.
     */
    function remainingPercent(usedPercent) {
      return typeof usedPercent === "number" && Number.isFinite(usedPercent) ? 100 - usedPercent : undefined
    }

    function toneFor(remaining) {
      if (typeof remaining !== "number" || !Number.isFinite(remaining)) return "idle"
      if (remaining <= 0) return "spent"
      return remaining <= 20 ? "warn" : "ok"
    }

    function Meter({ label, remaining, resetAt, now }) {
      const known = typeof remaining === "number" && Number.isFinite(remaining)
      const left = known ? Math.max(0, Math.min(100, Math.round(remaining))) : 0
      const reset = known ? resetLabel(resetAt, now) : undefined
      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, children: [
        jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: "var(--dsw-alias-label-secondary)" }, children: [
          jsx("span", { children: label }),
          jsx("span", { style: { fontVariantNumeric: "tabular-nums" }, children: known ? `剩余 ${left}%${reset ? ` · ${reset}` : ""}` : "暂无数据" }),
        ] }),
        jsx("div", { style: { position: "relative", height: 6, borderRadius: 999, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" }, children:
          jsx("div", { style: { position: "absolute", inset: 0, width: `${left}%`, borderRadius: 999, background: STATE_COLOR[toneFor(remaining)] } }) }),
      ] })
    }

    function AccountRow({ account, now, isCurrent, isPinned, busy, onTogglePin }) {
      const cooling = typeof account.cooldownUntil === "number" && account.cooldownUntil > now
      const badgeTone = account.available ? (cooling ? "warn" : "ok") : "spent"
      const badgeText = account.available ? (cooling ? "冷却中" : "可用") : "额度耗尽"
      const used = sinceLabel(account.lastUsedAt, now)
      const meta = [used === undefined ? "尚未使用" : `上次使用 ${used}`, account.health < 0.95 ? `健康 ${Math.round(account.health * 100)}%` : undefined].filter(Boolean).join(" · ")
      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-bg-layer-1)", border: `.5px solid var(--dsw-alias-border-l3)`, minWidth: 0 }, children: [
        jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 }, children: [
          jsx("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: account.id }),
          isCurrent ? jsx("span", { style: tagStyle, children: "当前" }) : null,
          isPinned ? jsx("span", { style: tagStyle, children: "已固定" }) : null,
          jsx("span", { style: { flex: 1, minWidth: 0 } }),
          jsx("span", { style: { flexShrink: 0, color: STATE_COLOR[badgeTone], fontSize: 11 }, children: badgeText }),
          jsx("button", { type: "button", disabled: busy, onClick: () => onTogglePin(isPinned ? null : account.id), style: smallButtonStyle, children: isPinned ? "取消固定" : "用此账号" }),
        ] }),
        jsx("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 11, fontVariantNumeric: "tabular-nums" }, children: meta }),
        jsx(Meter, { label: "5 小时窗口", remaining: remainingPercent(account.usedPercent5h), resetAt: account.resetsAt5h, now }),
        jsx(Meter, { label: "本周窗口", remaining: remainingPercent(account.usedPercentWeekly), resetAt: account.resetsAtWeekly, now }),
      ] })
    }

    function QuotaPanel({ provider }) {
      if (provider.provider !== "openai-codex") return null
      const { status, snapshot, apply } = usePool()
      const [pinState, setPinState] = React.useState("idle")
      const now = Date.now()
      const accounts = snapshot?.accounts ?? []
      const pinned = snapshot?.pinned
      const heading = snapshot === undefined ? "多账号额度" : `多账号额度 · ${STRATEGY_LABEL[snapshot.strategy] ?? snapshot.strategy}`
      // The hook fires on the first request the patched adapter makes; a stock
      // adapter instead announces itself by resolving the key with no options.
      const unpatched = snapshot?.integration?.hooked === false && snapshot?.integration?.stockAdapter === true
      // The account the last request went out on is the one in use right now.
      const currentId = accounts.reduce((best, account) => (
        typeof account.lastUsedAt === "number" && (best === undefined || account.lastUsedAt > best.at) ? { id: account.id, at: account.lastUsedAt } : best
      ), undefined)?.id
      // A pin makes way for a spent account instead of failing every request, so
      // say that out loud rather than letting "fixed" look broken.
      const pinnedAccount = accounts.find((account) => account.id === pinned)
      const pinFallingBack = pinned !== undefined && (pinnedAccount === undefined || !pinnedAccount.available)

      async function switchTo(id) {
        if (pinState === "saving") return
        setPinState("saving")
        try {
          const response = await fetch(QUOTA_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ pin: id }),
          })
          if (!response.ok) throw new Error(String(response.status))
          apply(await response.json())
          setPinState("idle")
        } catch {
          setPinState("failed")
        }
      }

      return jsxs("div", { style: fieldStyle, children: [
        jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
          jsx("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, fontWeight: 500 }, children: heading }),
          jsx("span", { style: { flex: 1 } }),
          pinned !== undefined ? jsx("button", { type: "button", disabled: pinState === "saving", onClick: () => switchTo(null), style: smallButtonStyle, children: "恢复自动" }) : null,
          jsx("span", { role: "status", style: { flexShrink: 0, color: status === "offline" ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)", fontSize: 11 }, children: status === "loading" ? "读取中" : status === "offline" ? "已断开，显示最后一次读数" : "15 秒自动刷新" }),
        ] }),
        pinState === "failed" ? jsx("span", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 }, children: "切换账号失败，请重试" }) : null,
        status === "offline" && snapshot === undefined
          ? jsx("span", { role: "alert", style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 }, children: "多账号额度不可用（当前运行环境未提供 Web 接口）" })
          : unpatched
            ? jsx("span", { role: "alert", style: { color: "var(--dsw-alias-state-warn-primary)", fontSize: 12 }, children: "额度观测未生效：当前 llm-pi-ai 未适配本插件（补丁未应用，或官方包升级后补丁已失效）。账号切换仍然可用，但额度不会更新。" })
            : accounts.length === 0
            ? jsx("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 }, children: "尚未列出账号：账号目录仍在读取，或未发现任何登录（检查 accountsDir 下是否存在 <name>/auth.json）" })
            : jsxs(React.Fragment, { children: [
              pinFallingBack ? jsx("span", { role: "status", style: { color: "var(--dsw-alias-state-warn-primary)", fontSize: 12 }, children: `固定账号 ${pinned} 当前不可用（额度耗尽或冷却中），已临时回退到自动选择；它的窗口重置后会自动恢复。` }) : null,
              jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: accounts.map((account) => jsx(AccountRow, {
                account,
                now,
                isCurrent: account.id === currentId,
                isPinned: account.id === pinned,
                busy: pinState === "saving",
                onTogglePin: switchTo,
              }, account.id)) }),
            ] }),
      ] })
    }

    function CodexProviderCard(props) {
      if (props.provider.provider !== "openai-codex") return null
      return jsxs(React.Fragment, { children: [jsx(ProxyField, props), jsx(QuotaPanel, props)] })
    }

    function apply(ctx) {
      const form = ctx.configForms.get("llm-pi-ai")
      ctx.effect(() => ctx.configForms.whileServed(["llm-pi-ai"], () => ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
        name: "settings.models.provider-card",
        key: "llm-pi-ai",
        inject: () => ({ form }),
      }, CodexProviderCard))))
    }

    module.exports = { apply, inject }
    return module.exports
  },
})