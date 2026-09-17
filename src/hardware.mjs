// What the machine has, and which qwen3 sizes to test on it.
import os from "node:os";
import { execFileSync } from "node:child_process";
import { statfsSync, existsSync } from "node:fs";
import path from "node:path";

// Downloads are Ollama's 4-bit builds; "needs" is the memory to run fully on the GPU (or in Apple's unified memory)
// with the benchmark's context, a little above the weights.
export const MODELS = [
  { name: "qwen3:4b", downloadGB: 2.5, needsGB: 4 },
  { name: "qwen3:8b", downloadGB: 5.2, needsGB: 8 },
  { name: "qwen3:14b", downloadGB: 9.3, needsGB: 12 },
  { name: "qwen3:32b", downloadGB: 20, needsGB: 24 },
];

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }); } catch { return null; } };

// nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits → one line per GPU ("…, 24564, 23020")
export function parseNvidiaSmi(out) {
  if (!out) return [];
  return out.trim().split("\n").map((l) => l.split(",").map((x) => x.trim())).filter((p) => p.length >= 3 && !isNaN(+p[1]))
    .map(([name, total, free]) => ({ vendor: "NVIDIA", name, totalGB: +(+total / 1024).toFixed(1), freeGB: +(+free / 1024).toFixed(1) }));
}
// rocm-smi --showproductname --showmeminfo vram --json → { card0: { "Card series": …, "VRAM Total Memory (B)": …, "VRAM Total Used Memory (B)": … } }
export function parseRocmSmi(out) {
  if (!out) return [];
  let j; try { j = JSON.parse(out); } catch { return []; }
  return Object.values(j).filter((c) => c && c["VRAM Total Memory (B)"]).map((c) => {
    const total = +c["VRAM Total Memory (B)"], used = +(c["VRAM Total Used Memory (B)"] || 0);
    return { vendor: "AMD", name: c["Card series"] || c["Card model"] || "AMD GPU", totalGB: +(total / 1024 ** 3).toFixed(1), freeGB: +((total - used) / 1024 ** 3).toFixed(1) };
  });
}

export function detect() {
  const platform = os.platform();
  const cpus = os.cpus();
  const machine = {
    os: `${platform} ${os.release()} (${os.arch()})`,
    cpu: (cpus[0]?.model || "unknown").replace(/\s+/g, " ").trim(),
    cores: cpus.length,
    ramGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    freeRamGB: +(os.freemem() / 1024 ** 3).toFixed(1),
    gpus: [],
    appleSilicon: platform === "darwin" && os.arch() === "arm64",
  };
  machine.gpus = [...parseNvidiaSmi(run("nvidia-smi", ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"])),
    ...parseRocmSmi(run("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--json"]))];
  if (machine.appleSilicon) machine.cpu = (run("sysctl", ["-n", "machdep.cpu.brand_string"]) || machine.cpu).trim();
  return machine;
}

// The memory a model can use on this machine: the largest GPU's free memory, or ~70% of RAM on Apple Silicon
// (unified memory), or RAM on a CPU-only machine (where larger models run, but slowly).
export function budget(machine) {
  const gpu = [...machine.gpus].sort((a, b) => b.freeGB - a.freeGB)[0];
  if (gpu) return { where: `GPU (${gpu.name})`, gb: gpu.freeGB, gpu: true };
  if (machine.appleSilicon) return { where: "Apple unified memory", gb: +(machine.ramGB * 0.7).toFixed(1), gpu: true };
  return { where: "CPU (no supported GPU found)", gb: +(machine.ramGB * 0.6).toFixed(1), gpu: false };
}

// Which sizes to test: qwen3:4b always, larger ones when they fit. On a CPU-only machine at most 8b, and only with
// 16 GB of RAM: anything larger takes minutes per answer.
export function chooseModels(machine) {
  const b = budget(machine);
  const fits = MODELS.filter((m, i) => i === 0 || m.needsGB <= b.gb);
  return b.gpu ? fits : fits.filter((m) => m.name === "qwen3:4b" || (m.name === "qwen3:8b" && machine.ramGB >= 16));
}

// Free disk where Ollama keeps models (OLLAMA_MODELS, or ~/.ollama/models).
export function freeDiskGB() {
  let dir = process.env.OLLAMA_MODELS || path.join(os.homedir(), ".ollama", "models");
  while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try { const s = statfsSync(dir); return +((s.bavail * s.bsize) / 1024 ** 3).toFixed(1); } catch { return null; }
}
