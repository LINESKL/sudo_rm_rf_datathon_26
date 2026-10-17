import glob
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

INP = "/kaggle/input"
WORK = "/kaggle/working"
ONLY = os.environ.get("ONLY", "")  # подставляется run_kernel.sh


def find(name):
    hits = glob.glob(f"{INP}/**/{name}", recursive=True) + glob.glob(f"{WORK}/unz/**/{name}", recursive=True)
    return hits[0] if hits else None


for z in glob.glob(f"{INP}/**/*.zip", recursive=True):
    zipfile.ZipFile(z).extractall(os.path.join(WORK, "unz", os.path.basename(z)[:-4]))

code_root = os.path.dirname(os.path.dirname(find("ml/__init__.py")))
videos = os.path.dirname(find("Х-3.mov"))
labels = find("open_labels.xlsx")

gpus = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                      capture_output=True, text=True).stdout.strip().splitlines()
print("GPUs:", gpus, flush=True)
if not gpus or not all(any(k in g for k in ("T4", "L4", "A100", "A10")) for g in gpus):
    sys.exit("Unsupported GPU for vLLM (need compute capability >= 7.0, e.g. T4)")

model = os.environ.get("VLM_MODEL") or ("Qwen/Qwen3-VL-8B-Instruct" if len(gpus) >= 2 else "Qwen/Qwen3-VL-4B-Instruct")
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "vllm>=0.11", "-r",
                os.path.join(code_root, "requirements-ml.txt")], check=True)
log = open(f"{WORK}/vllm.log", "w")
srv = subprocess.Popen([sys.executable, "-m", "vllm.entrypoints.openai.api_server", "--model", model,
                        "--port", "8001", "--dtype", "half", "--tensor-parallel-size", str(len(gpus)),
                        "--max-model-len", "8192", "--limit-mm-per-prompt", '{"image": 6}',
                        "--gpu-memory-utilization", "0.9"], stdout=log, stderr=subprocess.STDOUT)
for _ in range(180):
    try:
        urllib.request.urlopen("http://localhost:8001/v1/models", timeout=2)
        break
    except Exception:
        if srv.poll() is not None:
            sys.exit("vLLM exited, see vllm.log")
        time.sleep(10)
else:
    sys.exit("vLLM did not start in 30 min")

env = os.environ | {"VLM_BASE_URL": "http://localhost:8001/v1", "VLM_MODEL": model, "PYTHONPATH": code_root}
cmd = [sys.executable, "-m", "eval.run_eval", "--videos", videos, "--labels", labels, "--out", f"{WORK}/out"]
if ONLY:
    cmd += ["--only", ONLY]
subprocess.run(cmd, check=False, env=env, cwd=code_root)
srv.terminate()
shutil.rmtree(f"{WORK}/unz", ignore_errors=True)
