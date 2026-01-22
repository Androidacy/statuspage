#!/bin/bash
set -e

# Skip commits in original repo to avoid merge conflicts
commit=true
origin=$(git remote get-url origin 2>/dev/null || echo "")
if [[ $origin == *statsig-io/statuspage* ]]; then
  commit=false
fi

# Parse config
declare -a KEYS
declare -a URLS

while IFS='=' read -r key url; do
  [[ -z "$key" || -z "$url" ]] && continue
  KEYS+=("$key")
  URLS+=("$url")
done < urls.cfg

echo "Health check starting for ${#KEYS[@]} services..."
mkdir -p logs

# Check a single URL with retries
check_url() {
  local key=$1
  local url=$2
  local result="failed"

  for attempt in 1 2 3; do
    # Use timeout, follow redirects, accept common success codes
    local http_code
    http_code=$(curl -s -o /dev/null -w '%{http_code}' \
      --connect-timeout 10 \
      --max-time 30 \
      -L "$url" 2>/dev/null || echo "000")

    case "$http_code" in
      200|201|202|204|301|302|303|307|308)
        result="success"
        break
        ;;
    esac

    # Brief pause before retry (only if not last attempt)
    [[ $attempt -lt 3 ]] && sleep 2
  done

  echo "$result"
}

# Run all checks in parallel
declare -A RESULTS
pids=()

for i in "${!KEYS[@]}"; do
  key="${KEYS[$i]}"
  url="${URLS[$i]}"

  # Run check in background, store result in temp file
  (
    result=$(check_url "$key" "$url")
    echo "$result" > "/tmp/health_${key}.tmp"
  ) &
  pids+=($!)
done

# Wait for all checks to complete
for pid in "${pids[@]}"; do
  wait "$pid" 2>/dev/null || true
done

# Collect results and write logs
dateTime=$(date -u +'%Y-%m-%d %H:%M')
changes=false

for key in "${KEYS[@]}"; do
  result=$(cat "/tmp/health_${key}.tmp" 2>/dev/null || echo "failed")
  rm -f "/tmp/health_${key}.tmp"

  echo "  $key: $result"

  if [[ $commit == true ]]; then
    logfile="logs/${key}_report.log"
    echo "$dateTime, $result" >> "$logfile"

    # Keep last 2000 entries
    if [[ $(wc -l < "$logfile") -gt 2000 ]]; then
      tail -2000 "$logfile" > "${logfile}.tmp" && mv "${logfile}.tmp" "$logfile"
    fi
    changes=true
  fi
done

# Commit changes if any
if [[ $commit == true && $changes == true ]]; then
  # Check if there are actual changes to commit
  if git diff --quiet logs/ 2>/dev/null; then
    echo "No changes to commit"
    exit 0
  fi

  git config --local user.name 'androidacy-user'
  git config --local user.email 'opensource@androidacy.com'
  git add logs/
  git commit -m '[Automated] Update Health Check Logs' --quiet
  git push --quiet
  echo "Changes committed and pushed"
fi
