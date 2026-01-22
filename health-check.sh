#!/bin/bash

# Skip commits in original repo to avoid merge conflicts
commit=true
origin=$(git remote get-url origin 2>/dev/null || echo "")
if [[ $origin == *statsig-io/statuspage* ]]; then
  commit=false
fi

# Create secure temp directory
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Parse config
declare -a KEYS
declare -a URLS

while IFS='=' read -r key url || [[ -n "$key" ]]; do
  # Skip empty lines and comments
  [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
  # Sanitize key: only allow alphanumeric and underscore
  key=$(echo "$key" | tr -cd '[:alnum:]_')
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

    [[ $attempt -lt 3 ]] && sleep 2
  done

  echo "$result"
}

# Run all checks in parallel
pids=()

for i in "${!KEYS[@]}"; do
  key="${KEYS[$i]}"
  url="${URLS[$i]}"

  (
    result=$(check_url "$key" "$url")
    echo "$result" > "$TMPDIR/${key}.tmp"
  ) &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  wait "$pid" 2>/dev/null || true
done

# Collect results
dateTime=$(date -u +'%Y-%m-%d %H:%M')
changes=false
failed_services=()
all_results=()

for i in "${!KEYS[@]}"; do
  key="${KEYS[$i]}"
  url="${URLS[$i]}"
  result=$(cat "$TMPDIR/${key}.tmp" 2>/dev/null || echo "failed")

  echo "  $key: $result"
  all_results+=("$key|$url|$result")

  if [[ $result == "failed" ]]; then
    failed_services+=("$key")
  fi

  if [[ $commit == true ]]; then
    logfile="logs/${key}_report.log"
    echo "$dateTime, $result" >> "$logfile"

    if [[ $(wc -l < "$logfile") -gt 2000 ]]; then
      tail -2000 "$logfile" > "${logfile}.tmp" && mv "${logfile}.tmp" "$logfile"
    fi
    changes=true
  fi
done

# Write GitHub Actions job summary
if [[ -n "$GITHUB_STEP_SUMMARY" ]]; then
  {
    echo "## Health Check Results"
    echo ""
    echo "| Service | URL | Status |"
    echo "|---------|-----|--------|"
    for entry in "${all_results[@]}"; do
      IFS='|' read -r key url result <<< "$entry"
      if [[ $result == "success" ]]; then
        echo "| $key | $url | :white_check_mark: Up |"
      else
        echo "| $key | $url | :x: **Down** |"
      fi
    done
    echo ""
    echo "_Checked at $dateTime UTC_"
  } >> "$GITHUB_STEP_SUMMARY"
fi

# Send webhook notification if services are down
if [[ ${#failed_services[@]} -gt 0 && -n "$NOTIFICATION_WEBHOOK" ]]; then
  failed_list=$(printf ", %s" "${failed_services[@]}")
  failed_list=${failed_list:2}

  # Escape for JSON
  json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g'
  }
  escaped_list=$(json_escape "$failed_list")

  payload="{\"content\":\"**Service Alert**: The following services are down: $escaped_list\",\"embeds\":[{\"title\":\"Health Check Failed\",\"description\":\"Services experiencing issues: $escaped_list\",\"color\":15158332,\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}"
  curl -s -X POST -H "Content-Type: application/json" -d "$payload" "$NOTIFICATION_WEBHOOK" >/dev/null 2>&1 || true
fi

# Commit changes
if [[ $commit == true && $changes == true ]]; then
  if ! git diff --quiet logs/ 2>/dev/null; then
    git config --local user.name 'androidacy-user'
    git config --local user.email 'opensource@androidacy.com'
    git add logs/
    git commit -m '[Automated] Update Health Check Logs' --quiet
    git push --quiet
    echo "Changes committed and pushed"
  fi
fi

# Exit with error if any service is down (triggers GitHub notification)
if [[ ${#failed_services[@]} -gt 0 ]]; then
  echo ""
  echo "ALERT: ${#failed_services[@]} service(s) down: ${failed_services[*]}"
  exit 1
fi

echo "All services operational"
