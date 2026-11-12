#!/bin/sh
# Scans each request the runner leaves in /work (A140). A request is /work/<id>/ with the site
# copy in files/ and an empty "ready" marker. Two engines run on it: ClamAV (signatures kept
# fresh by freshclam) and YARA webshell / PHP backdoor rules. Results go to result.csv
# (filename,signature_id,signature_name,signature_description), "engines" says which engines
# ran, "log" holds errors, and "done" holds the exit code (0 = scanned, 130 = cancelled). Ids are
# lower-case letters and digits only; anything else is ignored.
# Progress (A143): "phase" says which engine is running, and clam.out gets one line per file
# ClamAV has checked, which the runner counts. A "cancel" file (or the folder disappearing) stops
# the engine within a second.
set -u
umask 077

DB=/home/scanner/clamav
RULES=/opt/rules/webshells.yarc
UPDATE_EVERY=43200
LAST_UPDATE=0
mkdir -p "$DB"

update_signatures() {
  if freshclam --config-file=/etc/ulixops/freshclam.conf --quiet; then
    echo "scanner: ClamAV signatures up to date"
  else
    echo "scanner: freshclam failed; using the signatures already downloaded (if any)"
  fi
  LAST_UPDATE=$(date +%s)
}

# CSV field: quotes doubled, then wrapped in quotes.
csv() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"
}

# Runs an engine in the background so a cancel can stop it. Sets RC to its exit code.
run_engine() {
  dir="$1"
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ -e "$dir/cancel" ] || [ ! -d "$dir" ]; then kill "$pid" 2>/dev/null; fi
    sleep 1
  done
  RC=0
  wait "$pid" || RC=$?
}

cancelled() {
  [ -e "$1/cancel" ] || [ ! -d "$1" ]
}

finish() {
  printf '%s\n' "$2" > "$1/done.tmp" && mv "$1/done.tmp" "$1/done"
}

echo "scanner: watching /work"
update_signatures
while true; do
  now=$(date +%s)
  if [ $((now - LAST_UPDATE)) -ge "$UPDATE_EVERY" ]; then update_signatures; fi

  for ready in /work/*/ready; do
    [ -e "$ready" ] || continue
    dir="${ready%/ready}"
    id="${dir#/work/}"
    case "$id" in '' | *[!a-z0-9]*) continue ;; esac
    rm -f "$ready"
    echo "scanner: scanning $id"
    : > "$dir/log"
    engines=""
    out="$dir/result.csv.tmp"
    printf 'filename,signature_id,signature_name,signature_description\n' > "$out"

    # ClamAV: one "path: OK" / "path: Signature FOUND" line per file; exit 0 clean, 1 found, 2 error.
    printf 'clamav\n' > "$dir/phase"
    run_engine "$dir" sh -c 'exec clamscan --database="$1" --recursive --no-summary --stdout \
      --max-filesize=20M --max-scansize=60M "$2/files" > "$2/clam.out" 2>> "$2/log"' clam "$DB" "$dir"
    clam=$RC
    if cancelled "$dir"; then
      [ -d "$dir" ] && finish "$dir" 130
      echo "scanner: $id cancelled"
      continue
    fi
    if [ "$clam" -le 1 ]; then
      engines="${engines}clamav "
      sed -n 's/^\(.*\): \(.*\) FOUND$/\1\t\2/p' "$dir/clam.out" | while IFS="$(printf '\t')" read -r file sig; do
        printf '%s,%s,%s,%s\n' "$(csv "$file")" "$(csv "$sig")" "$(csv "$sig")" "$(csv "ClamAV signature")" >> "$out"
      done
    else
      echo "ClamAV could not scan (exit $clam); its signatures may still be downloading." >> "$dir/log"
    fi

    # YARA: "RuleName path" per match.
    printf 'yara\n' > "$dir/phase"
    run_engine "$dir" sh -c 'exec yara --compiled-rules --recursive --no-warnings --threads=2 \
      "$1" "$2/files" > "$2/yara.out" 2>> "$2/log"' yara "$RULES" "$dir"
    yrc=$RC
    if cancelled "$dir"; then
      [ -d "$dir" ] && finish "$dir" 130
      echo "scanner: $id cancelled"
      continue
    fi
    if [ "$yrc" -eq 0 ]; then
      engines="${engines}yara"
      while read -r rule file; do
        [ -n "$file" ] || continue
        printf '%s,%s,%s,%s\n' "$(csv "$file")" "$(csv "$rule")" "$(csv "$rule")" "$(csv "YARA webshell / PHP backdoor rule")" >> "$out"
      done < "$dir/yara.out"
    else
      echo "YARA could not scan (exit $yrc)." >> "$dir/log"
    fi

    rm -f "$dir/clam.out" "$dir/yara.out"
    printf '%s\n' "$engines" > "$dir/engines"
    if [ -n "$engines" ]; then
      mv "$out" "$dir/result.csv"
      finish "$dir" 0
    else
      rm -f "$out"
      finish "$dir" 2
    fi
    echo "scanner: $id finished (engines: ${engines:-none})"
  done
  sleep 3
done
