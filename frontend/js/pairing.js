const form = document.getElementById("pairForm");
const result = document.getElementById("result");
const errorBox = document.getElementById("error");
const codeBox = document.getElementById("code");
const message = document.getElementById("message");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.classList.add("hidden");
  result.classList.add("hidden");

  const phone = document.getElementById("phone").value.trim();
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Génération...";

  try {
    const response = await fetch("/api/pairing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone })
    });

    const data = await response.json();

    if (!response.ok) throw new Error(data.error || "Erreur serveur");

    result.classList.remove("hidden");
    codeBox.textContent = data.code || "CONNECTÉ";
    message.textContent = data.message;
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Générer le code";
  }
});
