#!/bin/zsh
#
# Installs two macOS Services (Quick Actions) that drop content into desk/input/:
#
#   "Send to Desk"       — selected text, available in any app
#   "Send File to Desk"  — selected files, available in Finder
#
# Usage: zsh src/scripts/install-macos-service.sh

set -euo pipefail

DESK_INPUT="$HOME/code/seashell/seashell-desk/desk/input"
SERVICES_DIR="$HOME/Library/Services"
mkdir -p "$SERVICES_DIR"

# ---------------------------------------------------------------------------
# Helper: write a workflow bundle
# $1 = bundle name (without .workflow)
# $2 = document.wflow content
# ---------------------------------------------------------------------------
install_workflow() {
  local name="$1"
  local content="$2"
  local bundle="$SERVICES_DIR/$name.workflow"
  mkdir -p "$bundle/Contents"
  echo "$content" > "$bundle/Contents/document.wflow"
  echo "  installed: $bundle"
}

# ---------------------------------------------------------------------------
# 1. Send to Desk — text input, available in every app
# ---------------------------------------------------------------------------
install_workflow "Send to Desk" '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>521</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Optional</key><true/>
          <key>Types</key>
          <array><string>com.apple.cocoa.string</string></array>
        </dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMApplication</key><array><string>Automator</string></array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key><dict/>
          <key>CheckedForUserDefaultShell</key><dict/>
          <key>inputMethod</key><dict/>
          <key>shell</key><dict/>
          <key>source</key><dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Types</key>
          <array><string>com.apple.cocoa.string</string></array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>DESK_INPUT="'"$DESK_INPUT"'"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DESK_INPUT"
cat - > "$DESK_INPUT/text-$TIMESTAMP.txt"</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>0</integer>
          <key>shell</key><string>/bin/zsh</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Category</key>
        <array><string>AMCategoryUtilities</string></array>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>A1B2C3D4-0001-0001-0001-000000000001</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string><string>Script</string>
          <string>Command</string><string>Run</string><string>Unix</string>
        </array>
        <key>OutputUUID</key><string>A1B2C3D4-0001-0001-0001-000000000002</string>
        <key>UUID</key><string>A1B2C3D4-0001-0001-0001-000000000003</string>
        <key>UnlockProtect</key><integer>0</integer>
        <key>isViewVisible</key><integer>1</integer>
        <key>location</key><string>309.000000:253.000000</string>
        <key>nibPath</key>
        <string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/English.lproj/main.nib</string>
      </dict>
      <key>isViewVisible</key><integer>1</integer>
    </dict>
  </array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu.text</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu.nothing</string>
    <key>serviceProcessesInput</key><integer>0</integer>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>'

# ---------------------------------------------------------------------------
# 2. Send File to Desk — file input, available in Finder
# ---------------------------------------------------------------------------
install_workflow "Send File to Desk" '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>521</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Optional</key><false/>
          <key>Types</key>
          <array><string>public.item</string></array>
        </dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMApplication</key><array><string>Automator</string></array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key><dict/>
          <key>CheckedForUserDefaultShell</key><dict/>
          <key>inputMethod</key><dict/>
          <key>shell</key><dict/>
          <key>source</key><dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Types</key>
          <array><string>public.item</string></array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>DESK_INPUT="'"$DESK_INPUT"'"
mkdir -p "$DESK_INPUT"
while IFS= read -r f; do
  cp "$f" "$DESK_INPUT/$(basename "$f")"
done</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>0</integer>
          <key>shell</key><string>/bin/zsh</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Category</key>
        <array><string>AMCategoryUtilities</string></array>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>B2C3D4E5-0002-0002-0002-000000000001</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string><string>Script</string>
          <string>Command</string><string>Run</string><string>Unix</string>
        </array>
        <key>OutputUUID</key><string>B2C3D4E5-0002-0002-0002-000000000002</string>
        <key>UUID</key><string>B2C3D4E5-0002-0002-0002-000000000003</string>
        <key>UnlockProtect</key><integer>0</integer>
        <key>isViewVisible</key><integer>1</integer>
        <key>location</key><string>309.000000:253.000000</string>
        <key>nibPath</key>
        <string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/English.lproj/main.nib</string>
      </dict>
      <key>isViewVisible</key><integer>1</integer>
    </dict>
  </array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu.files</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu.nothing</string>
    <key>serviceProcessesInput</key><integer>0</integer>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>'

# Flush the services database so the new items appear immediately
/System/Library/CoreServices/pbs -flush
killall cfprefsd 2>/dev/null || true

echo ""
echo "Done. Both services are installed."
echo ""
echo "  Send to Desk       — appears in Services menu when text is selected"
echo "  Send File to Desk  — appears in Services menu / right-click in Finder"
echo ""
echo "If they don't appear immediately, log out and back in (or restart Finder)."
