// Read QR enrollment secrets only from the fragment, then remove them from browser history immediately.
(() => {
  function consume(location,history,now=Date.now()) {
    const params=new URLSearchParams(location.hash.slice(1));
    if(!params.has('setup'))return null;
    history.replaceState(history.state,'',location.pathname+location.search);
    const code=params.get('setup')||'',expires=Number(params.get('expires'));
    if(!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)||!Number.isSafeInteger(expires))return {error:'This setup QR isn’t valid. Run SECURITY-SETUP.cmd on your PC for a fresh one.'};
    if(expires<=now)return {error:'This setup QR expired. Run SECURITY-SETUP.cmd on your PC for a fresh one.'};
    return {code,expires};
  }
  window.DesktopPocketLink=Object.freeze({consume});
})();
