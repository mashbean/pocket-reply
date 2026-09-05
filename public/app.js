const status = document.querySelector("#status");
const submit = document.querySelector("#submit");
fetch("/api/health").then((r) => r.json()).then((health) => {
  if (health && Number.isFinite(health.maxQuestions)) document.querySelector("#max-questions").textContent = String(health.maxQuestions);
}).catch(() => {});

document.querySelector("#create").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.querySelector("#file").files[0];
  let csv = document.querySelector("#csv").value;
  if (file) csv = await file.text();
  if (!csv.trim()) return void (status.textContent = "請放入提問池 CSV。");
  if (!document.querySelector("#confirmed").checked) return void (status.textContent = "請先確認你有權以回覆者名義公開回覆，且會人工檢查。");
  submit.disabled = true;
  status.textContent = "正在檢查 CSV 並建立…";
  try {
    const response = await fetch("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: document.querySelector("#title").value,
        speaker: document.querySelector("#speaker").value,
        standfirst: document.querySelector("#standfirst").value,
        positions: document.querySelector("#positions").value,
        language: document.querySelector("#language").value,
        csv,
        confirmed: true,
      }),
    });
    const body = await response.json();
    if (!response.ok) return void (status.textContent = body.error || `建立失敗（${response.status}）`);
    document.querySelector("#receipt-link").href = body.urls.receipt;
    document.querySelector("#receipt-link").textContent = body.urls.receipt;
    document.querySelector("#manage-link").href = body.urls.manage;
    document.querySelector("#manage-link").textContent = body.urls.manage;
    document.querySelector("#result").classList.remove("hidden");
    status.textContent = `已建立，共 ${body.questions} 則提問。`;
    document.querySelector("#result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "建立失敗。";
  } finally {
    submit.disabled = false;
  }
});
