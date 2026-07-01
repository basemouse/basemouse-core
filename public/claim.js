// Progressive enhancement for the claim page: the copy button. The page is
// fully functional without this (the key text is selectable/select-all).
(function () {
  var button = document.getElementById('copy-key');
  var keyEl = document.getElementById('claim-key');
  if (!button || !keyEl) return;
  button.addEventListener('click', function () {
    var text = keyEl.textContent.trim();
    function done() {
      button.textContent = 'Copied ✓';
      setTimeout(function () { button.textContent = 'Copy key'; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var range = document.createRange();
      range.selectNodeContents(keyEl);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done();
    }
  });
})();
