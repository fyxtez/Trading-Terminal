import { useEffect, useState } from "react";
import "./ViewportSizeBadge.css";

type ViewportSize = {
  width: number;
  height: number;
};

function readViewportSize(): ViewportSize {
  return {
    width: Math.round(window.innerWidth),
    height: Math.round(window.innerHeight),
  };
}

export default function ViewportSizeBadge() {
  const [size, setSize] = useState(readViewportSize);

  useEffect(() => {
    const updateSize = () => setSize(readViewportSize());
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  return (
    <output className="viewport-size-badge" aria-label="Viewport size">
      VIEWPORT&nbsp; {size.width} × {size.height}
    </output>
  );
}
