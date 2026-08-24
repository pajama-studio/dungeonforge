// Camera bookmarks. Fly to a framing you like, press C (or the ✛ button),
// and it is kept. The point of the tool is the Copy button: the list comes
// out as JSON that can be pasted straight back into a conversation or into
// a shot list, so choreographing a flythrough stops being guesswork about
// coordinates and becomes editing a list of real framings.
//
// Deliberately independent of the editor drawer: capturing shots is
// something you do WHILE flying the camera, and a 268px panel in the way is
// exactly what you don't want then.

import type * as THREE from "three/webgpu";

export interface CameraShot {
  id: number;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  note: string;
}

const STORAGE_KEY = "dungeonforge.camera.shots.v1";

interface ShotsHost {
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3; update: () => void; autoRotate: boolean };
  /** stop anything that would fight us for the camera when jumping to a shot */
  quiesce: () => void;
  toast?: (message: string) => void;
}

const round = (n: number) => Math.round(n * 100) / 100;

export class CameraShots {
  private shots: CameraShot[] = [];
  private nextId = 1;
  private root: HTMLElement;
  private list: HTMLElement;
  private count: HTMLElement;

  constructor(private host: ShotsHost) {
    this.root = document.createElement("aside");
    this.root.id = "shots";
    this.root.className = "closed";
    this.root.setAttribute("aria-hidden", "true");

    const head = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "Camera shots";
    this.count = document.createElement("span");
    this.count.className = "shots-count";
    head.append(title, this.count);
    this.root.appendChild(head);

    const actions = document.createElement("div");
    actions.className = "shots-actions";
    const capture = document.createElement("button");
    capture.className = "shots-capture";
    capture.textContent = "✛ Capture";
    capture.title = "save the current framing (C)";
    capture.addEventListener("click", () => this.capture());
    const copy = document.createElement("button");
    copy.textContent = "⧉ Copy";
    copy.title = "copy every shot as JSON";
    copy.addEventListener("click", () => void this.copy());
    const clear = document.createElement("button");
    clear.className = "danger";
    clear.textContent = "✕";
    clear.title = "delete every shot";
    clear.addEventListener("click", () => this.clear());
    actions.append(capture, copy, clear);
    this.root.appendChild(actions);

    this.list = document.createElement("div");
    this.list.className = "shots-list";
    this.root.appendChild(this.list);

    document.body.appendChild(this.root);
    this.restore();
    this.render();
  }

  get open(): boolean {
    return !this.root.classList.contains("closed");
  }

  toggle(force?: boolean): void {
    const next = force ?? !this.open;
    this.root.classList.toggle("closed", !next);
    this.root.setAttribute("aria-hidden", next ? "false" : "true");
  }

  capture(): CameraShot {
    const { camera, controls } = this.host;
    const shot: CameraShot = {
      id: this.nextId++,
      position: camera.position.toArray().map(round) as [number, number, number],
      target: controls.target.toArray().map(round) as [number, number, number],
      fov: round(camera.fov),
      note: "",
    };
    this.shots.push(shot);
    this.persist();
    this.render();
    this.toggle(true);
    this.host.toast?.(`shot ${this.shots.length} captured`);
    return shot;
  }

  /** Snap the camera to a saved framing. */
  go(id: number): void {
    const shot = this.shots.find((s) => s.id === id);
    if (!shot) return;
    this.host.quiesce();
    this.host.controls.autoRotate = false;
    this.host.camera.position.fromArray(shot.position);
    this.host.controls.target.fromArray(shot.target);
    this.host.camera.fov = shot.fov;
    this.host.camera.updateProjectionMatrix();
    this.host.controls.update();
  }

  remove(id: number): void {
    this.shots = this.shots.filter((s) => s.id !== id);
    this.persist();
    this.render();
  }

  clear(): void {
    this.shots = [];
    this.persist();
    this.render();
  }

  /** The whole point of the tool: hand the list over as text. */
  async copy(): Promise<void> {
    const text = JSON.stringify(this.shots.map(({ id, ...rest }) => rest), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.host.toast?.(`${this.shots.length} shots copied`);
    } catch {
      // Clipboard access can be refused; falling back to a selectable
      // textarea beats losing the take.
      const area = document.createElement("textarea");
      area.value = text;
      area.className = "shots-fallback";
      this.root.appendChild(area);
      area.select();
      this.host.toast?.("select and copy");
    }
    console.info("[shots]\n" + text);
  }

  list_(): CameraShot[] {
    return [...this.shots];
  }

  private render(): void {
    this.count.textContent = this.shots.length ? String(this.shots.length) : "";
    this.list.textContent = "";
    if (this.shots.length === 0) {
      const empty = document.createElement("p");
      empty.className = "shots-empty";
      empty.textContent = "Fly somewhere, then press C.";
      this.list.appendChild(empty);
      return;
    }
    this.shots.forEach((shot, index) => {
      const row = document.createElement("div");
      row.className = "shots-row";
      const go = document.createElement("button");
      go.className = "shots-go";
      go.innerHTML = `<b>${String(index + 1).padStart(2, "0")}</b>`
        + `<span>${shot.position.map((n) => Math.round(n)).join(", ")}</span>`;
      go.title = "jump to this framing";
      go.addEventListener("click", () => this.go(shot.id));
      const note = document.createElement("input");
      note.className = "shots-note";
      note.placeholder = "note…";
      note.value = shot.note;
      note.addEventListener("change", () => {
        shot.note = note.value;
        this.persist();
      });
      const del = document.createElement("button");
      del.className = "shots-del";
      del.textContent = "✕";
      del.title = "delete";
      del.addEventListener("click", () => this.remove(shot.id));
      row.append(go, note, del);
      this.list.appendChild(row);
    });
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.shots));
    } catch {
      /* a full quota should not take the tool down */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as CameraShot[];
      if (!Array.isArray(parsed)) return;
      this.shots = parsed.filter((s) =>
        Array.isArray(s.position) && s.position.length === 3
        && Array.isArray(s.target) && s.target.length === 3);
      this.nextId = this.shots.reduce((max, s) => Math.max(max, s.id), 0) + 1;
    } catch {
      /* corrupt storage just means starting fresh */
    }
  }
}
