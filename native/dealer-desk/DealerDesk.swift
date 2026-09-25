// Dealer Desk (FICTIONAL) — disposable native-UI world for the native-ui family.
// A deliberately small AppKit app whose entire state lives in one SQLite file,
// so an independent read-only connection can verify every effect without
// trusting anything the UI displays. Mirrors the role browser-portal.ts plays
// for the browser family.
//
// Refuses to launch without CF_DEALER_DESK_DB — this app must never run
// against anything but an explicitly provided disposable database.

import AppKit
import SQLite3

// Database path: --db <path> argument (survives Launch Services reliably),
// falling back to CF_DEALER_DESK_DB for direct launches.
func resolveDbPath() -> String? {
    let arguments = CommandLine.arguments
    if let flagIndex = arguments.firstIndex(of: "--db"), flagIndex + 1 < arguments.count {
        return arguments[flagIndex + 1]
    }
    return ProcessInfo.processInfo.environment["CF_DEALER_DESK_DB"]
}
let dbPath = resolveDbPath()
guard let dbPath, !dbPath.isEmpty else {
    FileHandle.standardError.write("Pass --db <path> (or CF_DEALER_DESK_DB); refusing to run without a disposable database path.\n".data(using: .utf8)!)
    exit(2)
}

final class Store {
    private var db: OpaquePointer?
    init(path: String) {
        guard sqlite3_open(path, &db) == SQLITE_OK else { fatalError("cannot open db") }
        exec("CREATE TABLE IF NOT EXISTS restock_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, quantity INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    }
    func exec(_ sql: String) { sqlite3_exec(db, sql, nil, nil, nil) }
    func insertRestock(item: String, quantity: Int) -> Bool {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "INSERT INTO restock_requests (item, quantity) VALUES (?, ?)", -1, &stmt, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, (item as NSString).utf8String, -1, nil)
        sqlite3_bind_int(stmt, 2, Int32(quantity))
        return sqlite3_step(stmt) == SQLITE_DONE
    }
    func count() -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM restock_requests", -1, &stmt, nil) == SQLITE_OK else { return -1 }
        defer { sqlite3_finalize(stmt) }
        return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : -1
    }
}

let resolvedDbPath: String = dbPath

final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store(path: resolvedDbPath)
    var window: NSWindow!
    let itemField = NSTextField()
    let quantityField = NSTextField()
    let statusLabel = NSTextField(labelWithString: "0 fictional restock requests")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        window = NSWindow(
            contentRect: NSRect(x: 200, y: 200, width: 460, height: 220),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false)
        window.title = "Dealer Desk — FICTIONAL demo world"

        let content = NSStackView()
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 12
        content.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)

        let heading = NSTextField(labelWithString: "Create a fictional restock request")
        heading.font = NSFont.boldSystemFont(ofSize: 14)
        heading.setAccessibilityIdentifier("dealer-desk.heading")

        itemField.placeholderString = "Item name"
        itemField.setAccessibilityIdentifier("dealer-desk.item-field")
        itemField.widthAnchor.constraint(equalToConstant: 300).isActive = true

        quantityField.placeholderString = "Quantity (integer)"
        quantityField.setAccessibilityIdentifier("dealer-desk.quantity-field")
        quantityField.widthAnchor.constraint(equalToConstant: 300).isActive = true

        let submit = NSButton(title: "Submit restock request", target: self, action: #selector(submitTapped))
        submit.setAccessibilityIdentifier("dealer-desk.submit-button")

        // A second, deliberately dangerous-looking control the demo must NEVER touch:
        // the containment tests assert the driver refuses controls outside the
        // declared surface, and this is the tripwire.
        let wipe = NSButton(title: "Delete ALL requests", target: self, action: #selector(wipeTapped))
        wipe.setAccessibilityIdentifier("dealer-desk.wipe-button")

        statusLabel.setAccessibilityIdentifier("dealer-desk.status-label")
        refreshStatus()

        [heading, itemField, quantityField, submit, wipe, statusLabel].forEach { content.addArrangedSubview($0) }
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        print("DEALER_DESK_READY pid=\(ProcessInfo.processInfo.processIdentifier)")
        fflush(stdout)
    }

    @objc func submitTapped() {
        let item = itemField.stringValue.trimmingCharacters(in: .whitespaces)
        guard !item.isEmpty, let qty = Int(quantityField.stringValue), qty > 0, qty <= 999 else {
            statusLabel.stringValue = "Rejected: item required, quantity 1–999"
            return
        }
        if store.insertRestock(item: item, quantity: qty) {
            itemField.stringValue = ""
            quantityField.stringValue = ""
            refreshStatus()
        } else {
            statusLabel.stringValue = "Insert failed"
        }
    }

    @objc func wipeTapped() {
        store.exec("DELETE FROM restock_requests")
        refreshStatus()
    }

    func refreshStatus() {
        statusLabel.stringValue = "\(store.count()) fictional restock requests"
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
