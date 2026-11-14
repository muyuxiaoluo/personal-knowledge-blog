import { useEffect, useRef, useState, type PointerEvent } from "react";

type Reaction = "watch" | "greet" | "pat" | "none";

export function useAsabaInteraction() {
  const follow = useRef<HTMLSpanElement>(null);
  const [reaction, setReaction] = useState<Reaction>("none");
  const [resting, setResting] = useState(false);
  const hovering = useRef(false);
  const frozen = useRef(false);
  const reactionTimer = useRef<number | undefined>(undefined);
  const restTimer = useRef<number | undefined>(undefined);
  const point = useRef({ x: 0, y: 0 });
  const stroke = useRef({ x: 0, direction: 0, distance: 0, turns: 0, lastPat: 0 });

  function updateTarget(x: number, y: number) {
    point.current = { x, y };
  }

  function resetTarget() {
    updateTarget(0, 0);
  }
  useEffect(() => () => {
    window.clearTimeout(reactionTimer.current);
    window.clearTimeout(restTimer.current);
  }, []);

  function wake(delay = 4000) {
    setResting(false);
    window.clearTimeout(restTimer.current);
    restTimer.current = window.setTimeout(() => setResting(hovering.current && !frozen.current), delay);
  }

  function respond(kind: "greet" | "pat") {
    window.clearTimeout(reactionTimer.current);
    setReaction(kind);
    wake(kind === "pat" ? 6500 : 4000);
    reactionTimer.current = window.setTimeout(() => setReaction(hovering.current && !frozen.current ? "watch" : "none"), kind === "pat" ? 1100 : 700);
  }

  function enter(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== "mouse") return;
    hovering.current = true;
    frozen.current = false;
    stroke.current = { x: event.clientX, direction: 0, distance: 0, turns: 0, lastPat: 0 };
    respond("greet");
    move(event);
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== "mouse" || frozen.current || event.buttons) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
    const y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
    updateTarget(x, y);
    wake();

    const gesture = stroke.current;
    const dx = event.clientX - gesture.x;
    if (y < -0.12 && Math.abs(dx) >= 3) {
      const direction = Math.sign(dx);
      gesture.distance += Math.abs(dx);
      if (gesture.direction && direction !== gesture.direction) gesture.turns += 1;
      gesture.direction = direction;
      gesture.x = event.clientX;
      if (gesture.turns >= 2 && gesture.distance >= 28 && performance.now() - gesture.lastPat > 1600) {
        gesture.lastPat = performance.now();
        gesture.turns = 0;
        gesture.distance = 0;
        respond("pat");
      }
    } else if (y >= -0.12) {
      gesture.x = event.clientX;
      gesture.direction = 0;
      gesture.distance = 0;
      gesture.turns = 0;
    }
  }

  function leave() {
    hovering.current = false;
    frozen.current = false;
    window.clearTimeout(reactionTimer.current);
    window.clearTimeout(restTimer.current);
    setReaction("none");
    setResting(false);
    resetTarget();
  }

  function freeze() {
    frozen.current = true;
    window.clearTimeout(restTimer.current);
    setResting(false);
    resetTarget();
  }

  function release() {
    frozen.current = false;
  }

  return { follow, point, reaction, resting, enter, move, leave, freeze, release, respond, wake };
}

