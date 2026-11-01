// Scanning QR codes and barcodes: the phone app uses the camera scanner plugin; a browser uses the camera
// with the built-in BarcodeDetector where it has one. Either way there is a box to type the code instead.
import { inApp } from './geo';

interface Detector { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare global { interface Window { BarcodeDetector?: new (o?: { formats?: string[] }) => Detector } }

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Opens the scanner over whatever is showing; resolves with the code, or null when cancelled. */
export async function scanCode(title = 'Scan a code'): Promise<string | null> {
  if (inApp) {
    try {
      const { scan } = await import('@tauri-apps/plugin-barcode-scanner');
      const r = await scan({ windowed: false });
      return r.content || null;
    } catch {
      /* no camera permission: fall through to typing it */
    }
  }
  const dlg = $('#scanDlg') as HTMLDialogElement;
  $('#scanTitle').textContent = title;
  const video = $('#scanVideo') as HTMLVideoElement;
  const msg = $('#scanMsg');
  const typed = $('#scanText') as HTMLInputElement;
  typed.value = '';
  let stream: MediaStream | null = null;
  let timer = 0;
  dlg.showModal();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    $('#scanCancel').onclick = () => done(null);
    $('#scanUse').onclick = () => done(typed.value.trim() || null);
    typed.onkeydown = (e) => { if (e.key === 'Enter') done(typed.value.trim() || null); };
    dlg.addEventListener('close', () => done(null), { once: true });
    if (!window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) {
      video.hidden = true;
      msg.textContent = 'This browser cannot read codes from the camera. Type the code instead.';
      return;
    }
    video.hidden = false;
    msg.textContent = 'Point the camera at the code.';
    const det = new window.BarcodeDetector();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then((s) => {
      if (settled) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      video.srcObject = s;
      void video.play().catch(() => {});
      timer = window.setInterval(async () => {
        if (video.readyState < 2) return;
        try {
          const found = await det.detect(video);
          if (found[0]?.rawValue) { navigator.vibrate?.(60); done(found[0].rawValue); }
        } catch { /* a frame it could not read */ }
      }, 250);
    }, () => {
      video.hidden = true;
      msg.textContent = 'The camera is not available. Type the code instead.';
    });
  });
}
