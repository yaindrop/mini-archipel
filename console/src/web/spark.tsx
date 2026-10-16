import { useEffect, useRef } from "react";

interface SparkProps {
  points: Array<{ ts: number; value: number }>;
  color?: string;
  fill?: boolean;
  max?: number;
}

/** Tiny dependency-free sparkline for live tiles. */
export function Spark({
  points,
  color = "#58a6ff",
  fill = true,
  max,
}: SparkProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    if (points.length < 2) return;

    let hi = max ?? Math.max(...points.map((p) => p.value));
    let lo = Math.min(...points.map((p) => p.value));
    if (hi === lo) hi = lo + 1;

    const stepX = width / (points.length - 1);
    const y = (value: number) =>
      height - 2 - ((value - lo) / (hi - lo)) * (height - 4);

    context.beginPath();
    points.forEach((point, index) => {
      const x = index * stepX;
      const py = y(point.value);
      if (index === 0) context.moveTo(x, py);
      else context.lineTo(x, py);
    });
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    context.stroke();

    if (fill) {
      context.lineTo(width, height);
      context.lineTo(0, height);
      context.closePath();
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, `${color}55`);
      gradient.addColorStop(1, `${color}00`);
      context.fillStyle = gradient;
      context.fill();
    }
  }, [points, color, fill, max]);

  return <canvas ref={canvasRef} className="spark" />;
}
