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

    function apply(ctx) {
      const form = ctx.configForms.get("llm-pi-ai")
      ctx.effect(() => ctx.configForms.whileServed(["llm-pi-ai"], () => ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
        name: "settings.models.provider-card",
        key: "llm-pi-ai",
        inject: () => ({ form }),
      }, ProxyField))))
    }

    module.exports = { apply, inject }
    return module.exports
  },
})
