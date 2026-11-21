// Random per-browser token used as a DETERRENT against one phone submitting for
// several students. It is not hardware identification (see README).
let memory = null;
export function deviceToken() {
  try {
    let t = localStorage.getItem("atendar_device");
    if (!t || t.length < 32) { t = randomHex(24); localStorage.setItem("atendar_device", t); }
    return t;
  } catch { return (memory ??= randomHex(24)); }
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
