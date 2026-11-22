import { onBeforeUnmount, ref } from 'vue';
import { readBarcodes, type ReadResult } from 'zxing-wasm/reader';

/**
 * 摄像头连续扫码 composable（zxing-wasm）。
 * 用法：把 videoEl 绑定到 <video>，start() 后每 ~220ms 抓一帧解码；
 * 同一条码在 cooldownMs 内只回调一次，避免连续帧重复触发。
 */
export function useScanner(onDetect: (text: string, format: string) => void, opts?: { cooldownMs?: number }) {
  const videoEl = ref<HTMLVideoElement | null>(null);
  const running = ref(false);
  const error = ref('');
  const lastText = ref('');
  const lastAt = ref(0);

  let stream: MediaStream | null = null;
  let raf = 0;
  let timer = 0;
  let busy = false;
  const cooldown = opts?.cooldownMs ?? 2500;

  const decodeFrame = async () => {
    if (busy || !videoEl.value || videoEl.value.readyState < 2) return;
    busy = true;
    try {
      const v = videoEl.value;
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const results: ReadResult[] = await readBarcodes(imageData, { tryHarder: true, tryRotate: true });
      if (results.length) {
        const text = results[0].text;
        const now = Date.now();
        if (text && (text !== lastText.value || now - lastAt.value > cooldown)) {
          lastText.value = text;
          lastAt.value = now;
          onDetect(text, results[0].format);
        }
      }
    } catch (e: any) {
      // 单帧解码失败忽略，继续下一帧
    } finally {
      busy = false;
    }
  };

  const start = async () => {
    error.value = '';
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('当前环境不支持摄像头（需 HTTPS 或 localhost）');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      await new Promise<void>((r) => setTimeout(r, 50));
      if (videoEl.value) {
        videoEl.value.srcObject = stream;
        await videoEl.value.play();
      }
      running.value = true;
      timer = window.setInterval(decodeFrame, 220);
    } catch (e: any) {
      error.value = e?.message || '无法打开摄像头';
      running.value = false;
    }
  };

  const stop = () => {
    running.value = false;
    if (timer) window.clearInterval(timer);
    if (raf) cancelAnimationFrame(raf);
    timer = 0;
    raf = 0;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (videoEl.value) videoEl.value.srcObject = null;
  };

  const pause = () => { if (timer) { window.clearInterval(timer); timer = 0; } };
  const resume = () => { if (running.value && !timer) timer = window.setInterval(decodeFrame, 220); };

  onBeforeUnmount(stop);

  return { videoEl, running, error, start, stop, pause, resume };
}
