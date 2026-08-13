const form=document.getElementById("pairForm");
const result=document.getElementById("result");
const errorBox=document.getElementById("error");
const loading=document.getElementById("loading");
const codeBox=document.getElementById("code");
const message=document.getElementById("message");
const btn=document.getElementById("submitBtn");

form.addEventListener("submit",async(e)=>{
  e.preventDefault();
  errorBox.classList.add("hidden");
  result.classList.add("hidden");
  loading.classList.remove("hidden");
  btn.disabled=true;

  const phone=document.getElementById("phone").value.replace(/[^\d]/g,"");

  try{
    const r=await fetch("/api/pairing",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({phone})
    });
    const data=await r.json();
    if(!r.ok||!data.ok) throw new Error(data.error||"Erreur de connexion.");

    loading.classList.add("hidden");
    result.classList.remove("hidden");
    codeBox.textContent=data.code||"CONNECTÉ";
    message.textContent=data.code
      ? "Saisissez immédiatement ce code dans WhatsApp."
      : "Session en cours de connexion.";
  }catch(err){
    loading.classList.add("hidden");
    errorBox.textContent=err.message;
    errorBox.classList.remove("hidden");
  }finally{
    btn.disabled=false;
  }
});
