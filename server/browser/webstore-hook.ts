/**
 * Script injected into every new page (Page.addScriptToEvaluateOnNewDocument).
 * On chromewebstore.google.com it relabels "Add to Chrome" buttons as
 * "Add to Cabinet" and routes the click to the daemon via the
 * `cabinetInstallExtension` runtime binding (Runtime.addBinding), which the
 * ExtensionManager handles. Everything is scoped to the web store host; other
 * pages are untouched.
 */
export const WEBSTORE_HOOK_SCRIPT = `(function () {
  if (location.hostname !== "chromewebstore.google.com") return;

  function extensionIdFromPath() {
    var match = location.pathname.match(/[a-p]{32}/);
    return match ? match[0] : null;
  }

  function isInstallButton(button) {
    var text = (button.textContent || "").toLowerCase();
    var label = (button.getAttribute("aria-label") || "").toLowerCase();
    return /add to chrome/.test(text) || /add to chrome/.test(label);
  }

  function relabel() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      if (!isInstallButton(button)) continue;
      if (button.getAttribute("data-cabinet-install") === "1") continue;
      button.setAttribute("data-cabinet-install", "1");
      if (button.textContent && /add to chrome/i.test(button.textContent)) {
        button.textContent = button.textContent.replace(/add to chrome/i, "Add to Cabinet");
      }
    }
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("button");
      if (!button || !isInstallButton(button)) return;
      var id = extensionIdFromPath();
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      button.disabled = true;
      button.textContent = "Installing...";
      try {
        window.cabinetInstallExtension(JSON.stringify({ id: id }));
      } catch (err) {
        button.disabled = false;
        button.textContent = "Failed";
      }
    },
    true
  );

  relabel();
  var observer = new MutationObserver(function () {
    relabel();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
`;
