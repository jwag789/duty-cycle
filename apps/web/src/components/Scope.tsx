import { useEffect, useRef } from 'react';

const WIDTH = 240;
const HEIGHT = 56;

/** Oscilloscope of the master output, triggered on a rising zero crossing so the wave holds still. */
export function Scope({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const scale = window.devicePixelRatio || 1;
    canvas.width = WIDTH * scale;
    canvas.height = HEIGHT * scale;
    context.scale(scale, scale);
    const stroke = getComputedStyle(canvas).getPropertyValue('--scope-line').trim() || '#ffb000';
    const data = new Float32Array(analyser?.fftSize ?? 2048);

    let frame = requestAnimationFrame(function draw() {
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.strokeStyle = stroke;
      context.lineWidth = 1.5;
      context.beginPath();

      if (analyser) {
        analyser.getFloatTimeDomainData(data);
        let start = 0;
        for (let i = 1; i < data.length / 2; i++) {
          if (data[i - 1]! < 0 && data[i]! >= 0) {
            start = i;
            break;
          }
        }
        const span = Math.min(data.length - start, 1024);
        for (let x = 0; x < WIDTH; x++) {
          const sample = data[start + Math.floor((x / WIDTH) * span)] ?? 0;
          const y = HEIGHT / 2 - sample * (HEIGHT / 2 - 2);
          if (x === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
      } else {
        context.moveTo(0, HEIGHT / 2);
        context.lineTo(WIDTH, HEIGHT / 2);
      }

      context.stroke();
      frame = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return <canvas ref={canvasRef} className="scope" style={{ width: WIDTH, height: HEIGHT }} aria-hidden="true" />;
}
