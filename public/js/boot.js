/*
 * If the app hasn't started after a while (very old browser, or a file that
 * didn't load), say so instead of showing "Loading…" forever.
 */
(function () {
  "use strict";
  setTimeout(function () {
    if (window.lcStarted) return;
    var box = document.getElementById("app");
    if (!box || !box.querySelector(".boot")) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var p = document.createElement("p");
    p.className = "boot";
    p.textContent = "The line check didn't start. Check the Wi-Fi and reload. If it keeps happening, update the tablet's browser (iPad: Settings > General > Software Update). Nothing saved on the tablet has been lost.";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = "Reload";
    b.onclick = function () { location.reload(); };
    box.appendChild(p);
    box.appendChild(b);
  }, 15000);
})();
