const radios = document.querySelectorAll('input[name="engine"]');
const credsBox = document.getElementById("bhashiniCreds");
const advancedToggle = document.getElementById("advancedToggle");
const fallbackRow = document.getElementById("fallbackRow");
const autoFallbackEl = document.getElementById("autoFallback");
const proxyUrlEl = document.getElementById("proxyUrl");
const saveBtn = document.getElementById("save");
const status = document.getElementById("status");

function refreshVisibility() {
  const engine = document.querySelector('input[name="engine"]:checked').value;
  // "auto" already tries everything, so the fallback toggle is only meaningful
  // when a single specific engine is chosen.
  fallbackRow.style.display = engine === "auto" ? "none" : "flex";
}
radios.forEach((r) => r.addEventListener("change", refreshVisibility));

advancedToggle.addEventListener("click", () => {
  const nowHidden = credsBox.classList.toggle("hidden");
  advancedToggle.textContent = nowHidden
    ? "Advanced: translation server ▾"
    : "Advanced: translation server ▴";
});

chrome.storage.sync.get(
  { engine: "auto", autoFallback: true, proxyBaseUrl: "" },
  ({ engine, autoFallback, proxyBaseUrl }) => {
    const target = document.querySelector(`input[name="engine"][value="${engine}"]`);
    if (target) target.checked = true;
    autoFallbackEl.checked = autoFallback;
    proxyUrlEl.value = proxyBaseUrl;
    if (proxyBaseUrl) {
      credsBox.classList.remove("hidden");
      advancedToggle.textContent = "Advanced: translation server ▴";
    }
    refreshVisibility();
  }
);

saveBtn.addEventListener("click", () => {
  const engine = document.querySelector('input[name="engine"]:checked').value;
  const autoFallback = autoFallbackEl.checked;
  const proxyBaseUrl = proxyUrlEl.value.trim();

  // Basic sanity check: if provided, the server URL must be a valid https URL.
  if (proxyBaseUrl) {
    let ok = false;
    try {
      ok = new URL(proxyBaseUrl).protocol === "https:";
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      status.textContent = "Server URL must be a valid https:// address.";
      status.className = "status err";
      return;
    }
  }

  chrome.storage.sync.set(
    { engine, autoFallback, proxyBaseUrl },
    () => {
      const labels = { auto: "Auto (C-DAC Pune → Bhashini → Google)", bhashini: "Bhashini", cdacPune: "C-DAC Pune", google: "Google Translate" };
      status.textContent = `Saved ✓ — using ${labels[engine]}.`;
      status.className = "status ok";
    }
  );
});
