// ax-helper — trusted accessibility driver for the native-ui family (Phase 1).
// Two commands, JSON out, exit codes over prose:
//
//   ax-helper snapshot <pid>
//     Sanitized control snapshot of one app: role, accessibility identifier,
//     and an opaque id derived from (role, identifier, index). Values,
//     window contents and free text are deliberately NOT included — the
//     snapshot is the only surface a planner (Phase 2) would ever see.
//
//   ax-helper act <pid> <opaqueId> press
//   ax-helper act <pid> <opaqueId> settext <value>
//     Performs exactly one bounded action on one control resolved via the
//     same opaque-id derivation. Anything unresolvable is a refusal, not a
//     guess. Role gating: press only on buttons, settext only on text fields.
//
// Containment beyond this file (one-write budgets, allowlists, surface
// declarations) lives in the TypeScript driver, mirroring browser-driver.ts.

import AppKit
import ApplicationServices
import CryptoKit
import Foundation

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

guard AXIsProcessTrusted() else {
    fail(3, "accessibility-permission-missing: grant Accessibility to the controlling process in System Settings > Privacy & Security > Accessibility")
}

let args = CommandLine.arguments
guard args.count >= 3, let pid = Int32(args[2]) else {
    fail(2, "usage: ax-helper snapshot <pid> | ax-helper act <pid> <opaqueId> press|settext [value]")
}
let appElement = AXUIElementCreateApplication(pid)

struct Control {
    let element: AXUIElement
    let role: String
    let identifier: String
    let index: Int
    var opaqueId: String {
        let digest = SHA256.hash(data: Data("\(role)|\(identifier)|\(index)".utf8))
        return "ax-" + digest.map { String(format: "%02x", $0) }.joined().prefix(16)
    }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func collectControls() -> [Control] {
    var controls: [Control] = []
    var queue: [AXUIElement] = [appElement]
    var index = 0
    var visited = 0
    while !queue.isEmpty, visited < 2_000 {
        let element = queue.removeFirst()
        visited += 1
        let role = (attribute(element, kAXRoleAttribute) as? String) ?? ""
        let identifier = (attribute(element, kAXIdentifierAttribute) as? String) ?? ""
        if !identifier.isEmpty, ["AXButton", "AXTextField", "AXStaticText"].contains(role) {
            controls.append(Control(element: element, role: role, identifier: identifier, index: index))
            index += 1
        }
        if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
            queue.append(contentsOf: children)
        }
    }
    return controls
}

let controls = collectControls()

switch args[1] {
case "snapshot":
    let entries = controls.map { control in
        "{\"opaqueId\":\"\(control.opaqueId)\",\"role\":\"\(control.role)\",\"identifier\":\"\(control.identifier)\"}"
    }
    print("[" + entries.joined(separator: ",") + "]")

case "act":
    guard args.count >= 5 else { fail(2, "act requires <opaqueId> and an action") }
    let target = args[3]
    let action = args[4]
    guard let control = controls.first(where: { $0.opaqueId == target }) else {
        fail(4, "refused: opaque id does not resolve against the live snapshot")
    }
    switch action {
    case "press":
        guard control.role == "AXButton" else { fail(4, "refused: press is only permitted on buttons") }
        guard AXUIElementPerformAction(control.element, kAXPressAction as CFString) == .success else {
            fail(5, "press failed")
        }
        print("{\"acted\":\"press\",\"opaqueId\":\"\(control.opaqueId)\"}")
    case "settext":
        guard control.role == "AXTextField" else { fail(4, "refused: settext is only permitted on text fields") }
        guard args.count >= 6 else { fail(2, "settext requires a value") }
        guard AXUIElementSetAttributeValue(control.element, kAXValueAttribute as CFString, args[5] as CFTypeRef) == .success else {
            fail(5, "settext failed")
        }
        print("{\"acted\":\"settext\",\"opaqueId\":\"\(control.opaqueId)\"}")
    default:
        fail(2, "unknown action \(action)")
    }

default:
    fail(2, "unknown command \(args[1])")
}
