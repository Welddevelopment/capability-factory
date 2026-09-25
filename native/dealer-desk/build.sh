#!/bin/zsh
# Build the fictional Dealer Desk world app + ax-helper (native-ui family, Phase 1).
set -e
cd "$(dirname "$0")"
swiftc -O DealerDesk.swift -o dealer-desk
swiftc -O AxHelper.swift -o ax-helper
mkdir -p DealerDesk.app/Contents/MacOS
cp dealer-desk DealerDesk.app/Contents/MacOS/dealer-desk
codesign -s - --force DealerDesk.app
echo "Built. Launch: CF_DEALER_DESK_DB=<disposable.sqlite> open -n ./DealerDesk.app"
echo "IMPORTANT: must be launched via 'open' (Launch Services) or the AX tree stays empty."
