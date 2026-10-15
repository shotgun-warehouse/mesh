import { useEffect, useRef, useState } from "react";

import type { ItemTrace, Snapshot, SnapshotDevice } from "../engine/engine";
import type { ActionBody, Point } from "../engine/types";
import { PACKET_COLOR } from "./format";

export type Tool = "select" | "add" | "cut" | "wall";

export type Selection =
  | { kind: "device"; id: string }
  | { kind: "link"; a: string; b: string }
  | { kind: "wall"; id: string }
  | null;

export type ContextTarget =
  { kind: "device"; id: string } | { kind: "link"; a: string; b: string };

type View = { scale: number; offsetX: number; offsetY: number };

type Interaction =
  | { kind: "none" }
  | {
      kind: "drag";
      id: string;
      position: Point;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | { kind: "pan"; startX: number; startY: number; view: View }
  | { kind: "wall"; a: Point; b: Point };

type Props = {
  snapshot: Snapshot | null;
  receivedAt: number;
  playing: boolean;
  speed: number;
  trace: ItemTrace | null;
  tool: Tool;
  selection: Selection;
  title?: string;
  onSelect: (selection: Selection) => void;
  onAction: (action: ActionBody) => void;
  onContextMenu: (
    target: ContextTarget,
    clientX: number,
    clientY: number,
  ) => void;
  onAddDevice: (position: Point) => void;
};

type Palette = {
  background: string;
  grid: string;
  text: string;
  muted: string;
  link: string;
  wall: string;
  selected: string;
  green: string;
  grey: string;
  red: string;
  orange: string;
};

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token("--map-bg"),
    grid: token("--map-grid"),
    text: token("--text"),
    muted: token("--text-muted"),
    link: token("--map-link"),
    wall: token("--map-wall"),
    selected: token("--accent"),
    green: token("--good"),
    grey: token("--map-device-empty"),
    red: token("--bad"),
    orange: token("--warn"),
  };
}

function mixColor(from: string, to: string, amount: number): string {
  const parse = (hex: string) => {
    const value = hex.replace("#", "");
    return [0, 2, 4].map((offset) =>
      parseInt(value.slice(offset, offset + 2), 16),
    );
  };
  const a = parse(from);
  const b = parse(to);
  const mixed = a.map((channel, index) =>
    Math.round(channel + (b[index]! - channel) * amount),
  );
  return `rgb(${mixed.join(",")})`;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared),
        );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const FAIL_FLASH_MS = 400;
const DEVICE_RADIUS_M = 1.1;

/** The venue map: devices, links, packets in flight and walls, drawn on a 2D canvas. */
export function MapCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const viewRef = useRef<View | null>(null);
  /** The view follows the canvas size until the user pans or zooms. */
  const userViewRef = useRef(false);
  const interactionRef = useRef<Interaction>({ kind: "none" });
  const hoverRef = useRef<string | null>(null);
  const paletteRef = useRef<Palette | null>(null);
  const [cursor, setCursor] = useState("default");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const refresh = () => {
      paletteRef.current = readPalette();
    };
    refresh();
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, []);

  // Fit the venue on first data, or when asked (F key / double-click on empty space).
  const fitView = () => {
    const canvas = canvasRef.current;
    const snapshot = propsRef.current.snapshot;
    if (!canvas || !snapshot) return;
    const points: Point[] = [
      ...snapshot.devices.map((device) => ({ x: device.x, y: device.y })),
      ...snapshot.walls.flatMap((wall) => [wall.a, wall.b]),
    ];
    if (points.length === 0) points.push({ x: 0, y: 0 }, { x: 100, y: 60 });
    const minX = Math.min(...points.map((p) => p.x)) - 6;
    const maxX = Math.max(...points.map((p) => p.x)) + 6;
    const minY = Math.min(...points.map((p) => p.y)) - 6;
    const maxY = Math.max(...points.map((p) => p.y)) + 6;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    viewRef.current = {
      scale,
      offsetX: (width - (maxX - minX) * scale) / 2 - minX * scale,
      offsetY: (height - (maxY - minY) * scale) / 2 - minY * scale,
    };
  };

  useEffect(() => {
    if (props.snapshot && !viewRef.current) fitView();
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "f" && !(event.target instanceof HTMLInputElement)) {
        userViewRef.current = false;
        fitView();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Draw loop.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const palette = paletteRef.current;
      if (!canvas || !palette) return;
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (
        canvas.width !== Math.round(width * ratio) ||
        canvas.height !== Math.round(height * ratio)
      ) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        if (!userViewRef.current) fitView();
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = palette.background;
      context.fillRect(0, 0, width, height);
      const { snapshot } = propsRef.current;
      const view = viewRef.current;
      if (!snapshot || !view) return;
      drawScene(context, palette, view, width, height);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  function toScreen(point: Point, view: View): Point {
    return {
      x: point.x * view.scale + view.offsetX,
      y: point.y * view.scale + view.offsetY,
    };
  }

  function toWorld(x: number, y: number): Point {
    const view = viewRef.current!;
    return {
      x: (x - view.offsetX) / view.scale,
      y: (y - view.offsetY) / view.scale,
    };
  }

  function devicePosition(device: SnapshotDevice): Point {
    const interaction = interactionRef.current;
    if (interaction.kind === "drag" && interaction.id === device.id)
      return interaction.position;
    return { x: device.x, y: device.y };
  }

  function deviceRadius(view: View): number {
    return Math.min(26, Math.max(9, DEVICE_RADIUS_M * view.scale));
  }

  /** Virtual time now, extrapolated from the last snapshot while playing. */
  function virtualNow(): number {
    const { snapshot, receivedAt, playing, speed } = propsRef.current;
    if (!snapshot) return 0;
    if (!playing) return snapshot.t;
    return snapshot.t + Math.min(100, performance.now() - receivedAt) * speed;
  }

  function drawScene(
    context: CanvasRenderingContext2D,
    palette: Palette,
    view: View,
    width: number,
    height: number,
  ) {
    const { snapshot, selection, trace } = propsRef.current;
    if (!snapshot) return;
    const devices = new Map(
      snapshot.devices.map((device) => [device.id, device]),
    );
    const now = virtualNow();
    const radius = deviceRadius(view);

    // Grid: 10 m.
    context.strokeStyle = palette.grid;
    context.lineWidth = 1;
    const step = 10 * view.scale;
    if (step > 12) {
      context.beginPath();
      for (let x = view.offsetX % step; x < width; x += step) {
        context.moveTo(x, 0);
        context.lineTo(x, height);
      }
      for (let y = view.offsetY % step; y < height; y += step) {
        context.moveTo(0, y);
        context.lineTo(width, y);
      }
      context.stroke();
    }

    // Walls.
    context.lineCap = "round";
    for (const wall of snapshot.walls) {
      const a = toScreen(wall.a, view);
      const b = toScreen(wall.b, view);
      const selected = selection?.kind === "wall" && selection.id === wall.id;
      context.strokeStyle = selected ? palette.selected : palette.wall;
      context.lineWidth = selected ? 7 : 5;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
    const interaction = interactionRef.current;
    if (interaction.kind === "wall") {
      const a = toScreen(interaction.a, view);
      const b = toScreen(interaction.b, view);
      context.strokeStyle = palette.wall;
      context.globalAlpha = 0.5;
      context.lineWidth = 5;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      context.globalAlpha = 1;
    }

    // Hover range circle.
    const hovered = hoverRef.current
      ? devices.get(hoverRef.current)
      : undefined;
    if (hovered) {
      const center = toScreen(devicePosition(hovered), view);
      context.strokeStyle = palette.muted;
      context.setLineDash([4, 6]);
      context.lineWidth = 1;
      context.beginPath();
      context.arc(
        center.x,
        center.y,
        snapshot.params.range * view.scale,
        0,
        Math.PI * 2,
      );
      context.stroke();
      context.setLineDash([]);
    }

    // Blocked pairs.
    for (const pair of snapshot.blocked) {
      const a = devices.get(pair.a);
      const b = devices.get(pair.b);
      if (!a || !b) continue;
      const pa = toScreen(devicePosition(a), view);
      const pb = toScreen(devicePosition(b), view);
      context.strokeStyle = palette.red;
      context.globalAlpha = 0.45;
      context.setLineDash([3, 5]);
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(pa.x, pa.y);
      context.lineTo(pb.x, pb.y);
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      context.lineWidth = 2.5;
      context.beginPath();
      context.moveTo(mid.x - 5, mid.y - 5);
      context.lineTo(mid.x + 5, mid.y + 5);
      context.moveTo(mid.x + 5, mid.y - 5);
      context.lineTo(mid.x - 5, mid.y + 5);
      context.stroke();
    }

    // Links.
    const traceEdges = new Set<string>();
    if (trace) {
      for (const holder of trace.holders) {
        if (holder.via)
          traceEdges.add([holder.via, holder.device].sort().join("|"));
      }
    }
    for (const link of snapshot.links) {
      const a = devices.get(link.a);
      const b = devices.get(link.b);
      if (!a || !b) continue;
      const pa = toScreen(devicePosition(a), view);
      const pb = toScreen(devicePosition(b), view);
      const selected =
        selection?.kind === "link" &&
        [selection.a, selection.b].sort().join("|") === link.key;
      const failing =
        link.lastFailAt !== null &&
        now - link.lastFailAt < FAIL_FLASH_MS &&
        now >= link.lastFailAt;
      context.strokeStyle = selected
        ? palette.selected
        : failing
          ? palette.red
          : palette.link;
      if (link.state === "up") {
        context.lineWidth =
          1.2 + Math.min(6, Math.sqrt(link.traffic) / 18) + (selected ? 2 : 0);
        context.setLineDash([]);
      } else {
        context.lineWidth = 1;
        context.setLineDash(link.state === "connecting" ? [6, 4] : [2, 5]);
        context.globalAlpha = 0.7;
      }
      if (trace && !traceEdges.has(link.key)) context.globalAlpha = 0.25;
      context.beginPath();
      context.moveTo(pa.x, pa.y);
      context.lineTo(pb.x, pb.y);
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
      if (link.pinned) {
        drawPadlock(context, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, palette);
      }
    }

    // Item trace path: arrows from the device it came from.
    if (trace) {
      context.strokeStyle = palette.orange;
      context.fillStyle = palette.orange;
      context.lineWidth = 3;
      for (const holder of trace.holders) {
        if (!holder.via) continue;
        const from = devices.get(holder.via);
        const to = devices.get(holder.device);
        if (!from || !to) continue;
        drawArrow(
          context,
          toScreen(devicePosition(from), view),
          toScreen(devicePosition(to), view),
          radius,
        );
      }
    }

    // Packets in flight.
    for (const packet of snapshot.packets) {
      const from = devices.get(packet.from);
      const to = devices.get(packet.to);
      if (!from || !to) continue;
      const duration = Math.max(1, packet.end - packet.start);
      const progress = (now - packet.start) / duration;
      const pa = toScreen(devicePosition(from), view);
      const pb = toScreen(devicePosition(to), view);
      if (packet.failed) {
        // A failed write bursts halfway.
        const burst = (now - packet.start) / duration - 0.5;
        if (progress < 0.5) {
          drawDot(context, pa, pb, progress, PACKET_COLOR[packet.kind], 3.5);
        } else if (burst < 1.5) {
          const center = {
            x: pa.x + (pb.x - pa.x) * 0.5,
            y: pa.y + (pb.y - pa.y) * 0.5,
          };
          context.strokeStyle = palette.red;
          context.globalAlpha = Math.max(0, 1 - burst / 1.5);
          context.lineWidth = 2;
          context.beginPath();
          context.arc(center.x, center.y, 3 + burst * 8, 0, Math.PI * 2);
          context.stroke();
          context.globalAlpha = 1;
        }
        continue;
      }
      if (progress < 0 || progress > 1) continue;
      drawDot(context, pa, pb, progress, PACKET_COLOR[packet.kind], 3.5);
    }

    // Devices.
    const holders = new Set(trace?.holders.map((holder) => holder.device));
    context.textAlign = "center";
    context.font = "11px system-ui, sans-serif";
    for (const device of snapshot.devices) {
      const center = toScreen(devicePosition(device), view);
      const off = device.power !== "on";
      const complete = device.missing === 0 && device.held > 0;
      const coverage =
        device.held === 0 && device.missing === 0 ? 0 : device.coverage;
      context.globalAlpha = off ? 0.45 : 1;
      context.fillStyle = complete
        ? palette.green
        : mixColor(palette.grey, palette.green, coverage * 0.85);
      context.beginPath();
      context.arc(center.x, center.y, radius, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;

      // Link slots: a thin ring that fills up as links approach the cap.
      if (device.power === "on") {
        context.strokeStyle =
          device.linkCount >= device.maxLinks ? palette.orange : palette.muted;
        context.lineWidth = 2;
        context.beginPath();
        context.arc(
          center.x,
          center.y,
          radius + 3,
          -Math.PI / 2,
          -Math.PI / 2 +
            (Math.PI * 2 * device.linkCount) / Math.max(1, device.maxLinks),
        );
        context.stroke();
      }

      const selected =
        selection?.kind === "device" && selection.id === device.id;
      if (selected) {
        context.strokeStyle = palette.selected;
        context.lineWidth = 3;
        context.beginPath();
        context.arc(center.x, center.y, radius + 7, 0, Math.PI * 2);
        context.stroke();
      }
      if (trace) {
        context.strokeStyle = holders.has(device.id)
          ? palette.orange
          : palette.red;
        context.lineWidth = 2.5;
        context.setLineDash(holders.has(device.id) ? [] : [3, 3]);
        context.beginPath();
        context.arc(center.x, center.y, radius + 5, 0, Math.PI * 2);
        context.stroke();
        context.setLineDash([]);
      }

      // Power icon in the middle.
      context.fillStyle = palette.text;
      context.font = `bold ${Math.round(radius * 0.9)}px system-ui, sans-serif`;
      context.textBaseline = "middle";
      if (device.power === "bluetoothOff")
        context.fillText("ᛒ̸", center.x, center.y + 1);
      else if (device.power === "appKilled")
        context.fillText("✕", center.x, center.y + 1);
      else if (complete) {
        context.fillStyle = "#fff";
        context.fillText("✓", center.x, center.y + 1);
      }

      // Missing badge.
      if (device.missing > 0) {
        const badge = {
          x: center.x + radius * 0.85,
          y: center.y - radius * 0.85,
        };
        const label = device.missing > 999 ? "999+" : String(device.missing);
        context.font = "bold 10px system-ui, sans-serif";
        const badgeWidth = Math.max(16, context.measureText(label).width + 8);
        context.fillStyle = palette.red;
        roundRect(
          context,
          badge.x - badgeWidth / 2,
          badge.y - 8,
          badgeWidth,
          16,
          8,
        );
        context.fill();
        context.fillStyle = "#fff";
        context.fillText(label, badge.x, badge.y + 0.5);
      }

      // Busy write queue.
      if (device.queueDepth > 2) {
        const badge = {
          x: center.x - radius * 0.85,
          y: center.y - radius * 0.85,
        };
        const label = `${device.queueDepth}`;
        context.font = "bold 10px system-ui, sans-serif";
        const badgeWidth = Math.max(16, context.measureText(label).width + 8);
        context.fillStyle = palette.orange;
        roundRect(
          context,
          badge.x - badgeWidth / 2,
          badge.y - 8,
          badgeWidth,
          16,
          3,
        );
        context.fill();
        context.fillStyle = "#000";
        context.fillText(label, badge.x, badge.y + 0.5);
      }

      // Labels need about 5 m between devices to stay readable; otherwise show them on hover.
      if (view.scale >= 16 || selected || hoverRef.current === device.id) {
        context.textBaseline = "top";
        context.font = "11px system-ui, sans-serif";
        context.fillStyle = off ? palette.muted : palette.text;
        context.fillText(device.label, center.x, center.y + radius + 6);
      }
    }
    context.textBaseline = "alphabetic";
  }

  function drawDot(
    context: CanvasRenderingContext2D,
    a: Point,
    b: Point,
    progress: number,
    color: string,
    size: number,
  ) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(
      a.x + (b.x - a.x) * progress,
      a.y + (b.y - a.y) * progress,
      size,
      0,
      Math.PI * 2,
    );
    context.fill();
  }

  function drawArrow(
    context: CanvasRenderingContext2D,
    from: Point,
    to: Point,
    radius: number,
  ) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const start = {
      x: from.x + Math.cos(angle) * radius,
      y: from.y + Math.sin(angle) * radius,
    };
    const end = {
      x: to.x - Math.cos(angle) * (radius + 6),
      y: to.y - Math.sin(angle) * (radius + 6),
    };
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.beginPath();
    context.moveTo(end.x + Math.cos(angle) * 6, end.y + Math.sin(angle) * 6);
    context.lineTo(
      end.x + Math.cos(angle + 2.5) * 8,
      end.y + Math.sin(angle + 2.5) * 8,
    );
    context.lineTo(
      end.x + Math.cos(angle - 2.5) * 8,
      end.y + Math.sin(angle - 2.5) * 8,
    );
    context.closePath();
    context.fill();
  }

  function drawPadlock(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    palette: Palette,
  ) {
    context.fillStyle = palette.background;
    context.strokeStyle = palette.text;
    context.lineWidth = 1.5;
    context.fillRect(x - 5, y - 2, 10, 8);
    context.strokeRect(x - 5, y - 2, 10, 8);
    context.beginPath();
    context.arc(x, y - 2, 3.5, Math.PI, 0);
    context.stroke();
  }

  function roundRect(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
  }

  // ─── Hit testing ───────────────────────────────────────────────────────────

  function hitDevice(x: number, y: number): SnapshotDevice | null {
    const { snapshot } = propsRef.current;
    const view = viewRef.current;
    if (!snapshot || !view) return null;
    const radius = deviceRadius(view) + 4;
    let best: SnapshotDevice | null = null;
    let bestDistance = Infinity;
    for (const device of snapshot.devices) {
      const center = toScreen(devicePosition(device), view);
      const distance = Math.hypot(center.x - x, center.y - y);
      if (distance <= radius && distance < bestDistance) {
        best = device;
        bestDistance = distance;
      }
    }
    return best;
  }

  function hitLink(x: number, y: number): { a: string; b: string } | null {
    const { snapshot } = propsRef.current;
    const view = viewRef.current;
    if (!snapshot || !view) return null;
    const devices = new Map(
      snapshot.devices.map((device) => [device.id, device]),
    );
    const pairs = [
      ...snapshot.links.map((link) => ({ a: link.a, b: link.b })),
      ...snapshot.blocked,
    ];
    let best: { a: string; b: string } | null = null;
    let bestDistance = 7;
    for (const pair of pairs) {
      const a = devices.get(pair.a);
      const b = devices.get(pair.b);
      if (!a || !b) continue;
      const distance = distanceToSegment(
        { x, y },
        toScreen(devicePosition(a), view),
        toScreen(devicePosition(b), view),
      );
      if (distance < bestDistance) {
        best = { a: pair.a, b: pair.b };
        bestDistance = distance;
      }
    }
    return best;
  }

  function hitWall(x: number, y: number): string | null {
    const { snapshot } = propsRef.current;
    const view = viewRef.current;
    if (!snapshot || !view) return null;
    for (const wall of snapshot.walls) {
      if (
        distanceToSegment(
          { x, y },
          toScreen(wall.a, view),
          toScreen(wall.b, view),
        ) < 6
      )
        return wall.id;
    }
    return null;
  }

  // ─── Pointer handling ──────────────────────────────────────────────────────

  function localPoint(
    event: React.PointerEvent | React.MouseEvent | React.WheelEvent,
  ): { x: number; y: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !viewRef.current) return;
    const { x, y } = localPoint(event);
    const { tool, onSelect, onAction, onAddDevice, snapshot } =
      propsRef.current;
    canvasRef.current!.setPointerCapture(event.pointerId);

    if (tool === "add") {
      onAddDevice(toWorld(x, y));
      return;
    }
    if (tool === "wall") {
      const point = toWorld(x, y);
      interactionRef.current = { kind: "wall", a: point, b: point };
      return;
    }
    if (tool === "cut") {
      const link = hitLink(x, y);
      if (link) {
        const blocked = snapshot?.blocked.some(
          (pair) => pair.key === [link.a, link.b].sort().join("|"),
        );
        onAction({
          do: blocked ? "unblockLink" : "blockLink",
          a: link.a,
          b: link.b,
        });
      }
      return;
    }

    const device = hitDevice(x, y);
    if (device) {
      onSelect({ kind: "device", id: device.id });
      interactionRef.current = {
        kind: "drag",
        id: device.id,
        position: { x: device.x, y: device.y },
        startX: x,
        startY: y,
        moved: false,
      };
      return;
    }
    const link = hitLink(x, y);
    if (link) {
      onSelect({ kind: "link", ...link });
      return;
    }
    const wall = hitWall(x, y);
    if (wall) {
      onSelect({ kind: "wall", id: wall });
      return;
    }
    onSelect(null);
    userViewRef.current = true;
    interactionRef.current = {
      kind: "pan",
      startX: x,
      startY: y,
      view: { ...viewRef.current },
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!viewRef.current) return;
    const { x, y } = localPoint(event);
    const interaction = interactionRef.current;
    if (interaction.kind === "drag") {
      // A click is not a move: only a drag past a few pixels records an action.
      if (
        !interaction.moved &&
        Math.hypot(x - interaction.startX, y - interaction.startY) < 4
      )
        return;
      interaction.position = toWorld(x, y);
      interaction.moved = true;
      return;
    }
    if (interaction.kind === "pan") {
      viewRef.current = {
        ...interaction.view,
        offsetX: interaction.view.offsetX + x - interaction.startX,
        offsetY: interaction.view.offsetY + y - interaction.startY,
      };
      return;
    }
    if (interaction.kind === "wall") {
      interaction.b = toWorld(x, y);
      return;
    }
    const device = hitDevice(x, y);
    hoverRef.current = device?.id ?? null;
    const { tool } = propsRef.current;
    const overLink = !device && hitLink(x, y);
    setCursor(
      tool === "add" || tool === "wall"
        ? "crosshair"
        : device
          ? "grab"
          : overLink
            ? "pointer"
            : "default",
    );
  };

  const onPointerUp = () => {
    const interaction = interactionRef.current;
    interactionRef.current = { kind: "none" };
    if (interaction.kind === "drag" && interaction.moved) {
      const round = (value: number) => Math.round(value * 10) / 10;
      propsRef.current.onAction({
        do: "moveDevice",
        device: interaction.id,
        position: {
          x: round(interaction.position.x),
          y: round(interaction.position.y),
        },
      });
    }
    if (
      interaction.kind === "wall" &&
      Math.hypot(
        interaction.b.x - interaction.a.x,
        interaction.b.y - interaction.a.y,
      ) > 1
    ) {
      const round = (point: Point) => ({
        x: Math.round(point.x * 10) / 10,
        y: Math.round(point.y * 10) / 10,
      });
      propsRef.current.onAction({
        do: "addWall",
        wall: {
          id: `wall-${Date.now().toString(36)}`,
          a: round(interaction.a),
          b: round(interaction.b),
        },
      });
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const view = viewRef.current;
    if (!view) return;
    const { x, y } = localPoint(event);
    userViewRef.current = true;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const scale = Math.max(1, Math.min(80, view.scale * factor));
    const world = toWorld(x, y);
    viewRef.current = {
      scale,
      offsetX: x - world.x * scale,
      offsetY: y - world.y * scale,
    };
  };

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const { x, y } = localPoint(event);
    const device = hitDevice(x, y);
    if (device) {
      propsRef.current.onSelect({ kind: "device", id: device.id });
      propsRef.current.onContextMenu(
        { kind: "device", id: device.id },
        event.clientX,
        event.clientY,
      );
      return;
    }
    const link = hitLink(x, y);
    if (link) {
      propsRef.current.onSelect({ kind: "link", ...link });
      propsRef.current.onContextMenu(
        { kind: "link", ...link },
        event.clientX,
        event.clientY,
      );
    }
  };

  return (
    <div className="map">
      {props.title && <div className="map-title">{props.title}</div>}
      <canvas
        ref={canvasRef}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoverRef.current = null;
        }}
        onDoubleClick={(event) => {
          const { x, y } = localPoint(event);
          if (!hitDevice(x, y) && !hitLink(x, y)) {
            userViewRef.current = false;
            fitView();
          }
        }}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}
