/**
 * dsh-pet — DSH 桌面宠物（Client 手写产物）。
 * 与 src/client/index.ts 语义一致；由 scripts/make-client.js 生成（内嵌精灵图 base64）。
 * 结构对齐 tsdown 输出：window.__ModuleLoader__.load({ id, factory })。
 *
 * 宠物本体已迁移到「全局置顶透明窗口」（Electron BrowserWindow，见 lib/pet-window.html），
 * 本 Client 只保留 DSH 设置页的「🐾 桌面宠物」开关（settings.general.item）。
 */
window.__ModuleLoader__.load({
	id: "dsh-pet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		var CSS = [
			".dsh-pet-settings-row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:13px;color:inherit;}",
			".dsh-pet-settings-row input{width:15px;height:15px;cursor:pointer;}"
		].join("\n");

		var inject = ["slots"];

		function apply(ctx) {
			ctx.effect(function () { return insertStyles(); }, "dsh-pet: styles");

			// 设置页开关：settings.general.item（控制全局置顶宠物显示/隐藏）
			ctx.effect(function () {
				return ctx.slots.inject("settings.general.item", function () {
					return ctx.slots.register({
						name: "settings.general.item",
						id: "dsh-pet-toggle",
						order: 200,
						label: function () { return "桌面宠物"; }
					}, ToggleEntry);
				});
			}, "dsh-pet: settings toggle");
		}

		function insertStyles() {
			var style = document.createElement("style");
			style.id = "dsh-pet-styles";
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		function createToggle(container) {
			var row = document.createElement("div");
			row.className = "dsh-pet-settings-row";
			var label = document.createElement("label");
			label.textContent = "🐾 桌面宠物（全局置顶）";
			var input = document.createElement("input");
			input.type = "checkbox";
			row.appendChild(label);
			row.appendChild(input);
			container.appendChild(row);

			fetch("/pet/api/state", { method: "POST", body: "{}" })
				.then(function (r) { return r.json(); })
				.then(function (j) { if (j && j.ok) input.checked = !!j.value.enabled; })
				.catch(function () {});
			function onChange() {
				fetch("/pet/api/set", { method: "POST", body: JSON.stringify({ enabled: input.checked }) })
					.catch(function () { input.checked = !input.checked; });
			}
			input.addEventListener("change", onChange);

			return function dispose() {
				input.removeEventListener("change", onChange);
				if (row.parentNode) row.parentNode.removeChild(row);
			};
		}

		// ── React 组件（slot 渲染要求 component 是 React 组件） ──
		function ToggleEntry(props) {
			var hostRef = React.useRef(null);
			React.useEffect(function () {
				var el = hostRef.current;
				if (!el) return;
				var dispose = createToggle(el);
				return function () { if (dispose) dispose(); };
			}, []);
			return React.createElement("div", { ref: hostRef, style: { display: "contents" } });
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
