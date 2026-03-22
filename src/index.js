const waService = require('./whatsapp/service');
const renderer = require('./ui/renderer');

async function main() {
  renderer.init();

  waService.on('lifecycle', (ev) => {
    renderer.updateBootPhase(ev);
  });

  await waService.initialize(
    // onQr
    (qr) => {
      renderer.showQr(qr);
    },
    // onReady
    () => {
      renderer.handleReady();
    },
    // onAuth
    () => {}
  );
}

main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
});
