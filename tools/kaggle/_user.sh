# Kaggle username: env KAGGLE_USERNAME, else ~/.kaggle/kaggle.json
KUSER="${KAGGLE_USERNAME:-$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.kaggle/kaggle.json')))['username'])" 2>/dev/null)}"
[ -n "$KUSER" ] || { echo "set KAGGLE_USERNAME" >&2; exit 1; }
