using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

// A normal-user bridge. No sockets, services, elevation, clipboard reads or file access.
// The parent owns authentication. Input arrives over stdin; framed output goes to stdout.
// desktop-pocket-perf: input is handled on the stdin thread and never waits behind a capture;
// captures run on their own thread, reuse their bitmaps, and (when the server asks for it with
// "patches": true) also send just the changed rectangle so small changes travel as small JPEGs.
// It also reports, through UI Automation, when a text box has keyboard focus ("focus" messages) and
// whether the spot under a finger is a text box ("probe"), so the phone can raise its keyboard.
class DesktopBridge
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Stream Output = Console.OpenStandardOutput();
    static readonly HashSet<string> Held = new HashSet<string>();
    static readonly ImageCodecInfo Jpeg = ImageCodecInfo.GetImageEncoders().First(x => x.MimeType == "image/jpeg");
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT ptScreenPos; }
    [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool icon; public int xHotspot, yHotspot; public IntPtr mask, color; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
    [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int cx, int cy, uint step, IntPtr brush, uint flags);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);

    static bool DesktopAvailable()
    {
        IntPtr desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return false;
        try { int needed; var name = new StringBuilder(128); return GetUserObjectInformation(desktop, 2, name, 256, out needed) && name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase); }
        finally { CloseDesktop(desktop); }
    }
    static readonly object OutputLock = new object();
    static void Packet(byte kind, byte[] body)
    {
        byte[] prefix = BitConverter.GetBytes(body.Length + 1);
        lock (OutputLock) { Output.Write(prefix, 0, 4); Output.WriteByte(kind); Output.Write(body, 0, body.Length); Output.Flush(); }
    }
    static string Serialize(object value) { lock (Json) return Json.Serialize(value); }
    static void Message(object value) { Packet(1, Encoding.UTF8.GetBytes(Serialize(value))); }
    static string S(Dictionary<string, object> d, string key, string fallback = "") { return d.ContainsKey(key) ? Convert.ToString(d[key]) : fallback; }
    static double N(Dictionary<string, object> d, string key, double fallback = 0) { return d.ContainsKey(key) ? Convert.ToDouble(d[key]) : fallback; }
    static Screen Monitor(Dictionary<string, object> d)
    {
        string id = S(d, "monitor");
        Screen screen = Screen.AllScreens.FirstOrDefault(x => x.DeviceName == id);
        if (screen == null && id != "") throw new Exception("Display changed. Select the display again.");
        return screen ?? Screen.PrimaryScreen;
    }
    // Reused between captures (capture thread only).
    static Bitmap fullBitmap, scaledBitmap;
    static int[] previous, current;
    static string previousKey = "";
    static int contentSeq = 0;
    static bool B(Dictionary<string, object> d, string key) { return d.ContainsKey(key) && d[key] is bool && (bool)d[key]; }
    internal static byte[] EncodeJpeg(Bitmap bitmap, long quality)
    {
        using (var memory = new MemoryStream())
        using (var parameters = new EncoderParameters(1))
        {
            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            bitmap.Save(memory, Jpeg, parameters); return memory.ToArray();
        }
    }
    static void Frame(byte kind, object meta, byte[] jpeg)
    {
        byte[] m = Encoding.UTF8.GetBytes(Serialize(meta));
        using (var memory = new MemoryStream())
        { memory.Write(BitConverter.GetBytes(m.Length), 0, 4); memory.Write(m, 0, m.Length); if (jpeg != null) memory.Write(jpeg, 0, jpeg.Length); Packet(kind, memory.ToArray()); }
    }
    // Compares this frame's pixels with the previous one. same = nothing changed; changed = bounding box (16-px aligned).
    internal static void Diff(Bitmap bitmap, string key, out Rectangle changed, out bool same, out bool havePrevious)
    {
        int width = bitmap.Width, height = bitmap.Height;
        changed = new Rectangle(0, 0, width, height); same = false;
        BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        int stride = Math.Abs(data.Stride), words = stride / 4, total = words * height;
        if (current == null || current.Length != total) current = new int[total];
        Marshal.Copy(data.Scan0, current, 0, total);
        bitmap.UnlockBits(data);
        havePrevious = previous != null && previous.Length == total && previousKey == key;
        if (havePrevious)
        {
            int top = -1, bottom = -1, left = int.MaxValue, right = -1;
            // Compare only the pixel bytes of each row; stride padding can hold garbage.
            int used = width * 3, full = used / 4, rest = used % 4, mask = rest == 0 ? 0 : (1 << (8 * rest)) - 1;
            for (int y = 0; y < height; y++)
            {
                int row = y * words, first = -1, last = -1;
                for (int i = 0; i < full; i++) if (current[row + i] != previous[row + i]) { first = i; break; }
                bool tail = rest != 0 && ((current[row + full] ^ previous[row + full]) & mask) != 0;
                if (first < 0 && !tail) continue;
                if (tail) last = full;
                else for (int i = full - 1; i >= first; i--) if (current[row + i] != previous[row + i]) { last = i; break; }
                if (first < 0) first = full;
                if (top < 0) top = y; bottom = y;
                left = Math.Min(left, first * 4 / 3); right = Math.Max(right, Math.Min(width - 1, (last * 4 + 3) / 3));
            }
            if (top < 0) same = true;
            else
            {
                int x0 = Math.Max(0, (left - 2) / 16 * 16), y0 = Math.Max(0, (top - 2) / 16 * 16);
                int x1 = Math.Min(width, (right + 2) / 16 * 16 + 16), y1 = Math.Min(height, (bottom + 2) / 16 * 16 + 16);
                changed = new Rectangle(x0, y0, x1 - x0, y1 - y0);
            }
        }
        int[] swap = previous; previous = current; current = swap; previousKey = key;
    }
    static void Capture(Dictionary<string, object> d)
    {
        if (!DesktopAvailable()) { previousKey = ""; throw new Exception("Windows is locked or showing a secure prompt. Unlock or dismiss the prompt on the PC."); }
        var timer = System.Diagnostics.Stopwatch.StartNew();
        Screen screen = Monitor(d); Rectangle bounds = screen.Bounds;
        int maxWidth = (int)Math.Max(640, Math.Min(1920, N(d, "width", 1280)));
        double ratio = Math.Min(1.0, (double)maxWidth / bounds.Width);
        int width = Math.Max(1, (int)(bounds.Width * ratio)), height = Math.Max(1, (int)(bounds.Height * ratio));
        long quality = (long)Math.Max(35, Math.Min(90, N(d, "quality", 65)));
        bool patches = B(d, "patches");
        if (!patches) previousKey = "";   // the previous pixels are only trusted while patches stay on
        var cursor = new CURSORINFO(); cursor.cbSize = Marshal.SizeOf(cursor);
        bool hasCursor = GetCursorInfo(ref cursor) && (cursor.flags & 1) != 0;

        if (fullBitmap == null || fullBitmap.Width != bounds.Width || fullBitmap.Height != bounds.Height)
        { if (fullBitmap != null) fullBitmap.Dispose(); fullBitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb); }
        if (scaledBitmap == null || scaledBitmap.Width != width || scaledBitmap.Height != height)
        { if (scaledBitmap != null) scaledBitmap.Dispose(); scaledBitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb); previousKey = ""; }

        using (Graphics graphics = Graphics.FromImage(fullBitmap))
        {
            graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
            if (hasCursor)
            {
                ICONINFO icon;
                if (GetIconInfo(cursor.hCursor, out icon))
                {
                    IntPtr dc = graphics.GetHdc();
                    try { DrawIconEx(dc, cursor.ptScreenPos.x - bounds.X - icon.xHotspot, cursor.ptScreenPos.y - bounds.Y - icon.yHotspot, cursor.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
                    finally { graphics.ReleaseHdc(dc); if (icon.mask != IntPtr.Zero) DeleteObject(icon.mask); if (icon.color != IntPtr.Zero) DeleteObject(icon.color); }
                }
            }
        }
        using (Graphics graphics = Graphics.FromImage(scaledBitmap))
        {
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.CompositingQuality = CompositingQuality.HighSpeed;
            graphics.PixelOffsetMode = PixelOffsetMode.HighSpeed;
            graphics.InterpolationMode = InterpolationMode.Bilinear;
            graphics.DrawImage(fullBitmap, 0, 0, width, height);
        }
        double captureMs = timer.Elapsed.TotalMilliseconds;

        var monitors = Screen.AllScreens.Select((x, i) => new { id = x.DeviceName, name = "Display " + (i + 1) + (x.Primary ? " · Main" : ""), width = x.Bounds.Width, height = x.Bounds.Height }).ToArray();
        double cursorX = hasCursor ? (double)(cursor.ptScreenPos.x - bounds.X) / bounds.Width : -1;
        double cursorY = hasCursor ? (double)(cursor.ptScreenPos.y - bounds.Y) / bounds.Height : -1;

        // Find the rectangle that changed since the previous capture.
        Rectangle changed = new Rectangle(0, 0, width, height);
        bool same = false, havePrevious = false;
        if (patches) Diff(scaledBitmap, screen.DeviceName + ":" + width + "x" + height, out changed, out same, out havePrevious);

        if (same)
        {
            // Nothing changed: tell the server without spending time on JPEG encoding.
            Frame(2, new { monitor = screen.DeviceName, width = width, height = height, desktopWidth = bounds.Width, desktopHeight = bounds.Height,
                cursorX = cursorX, cursorY = cursorY, monitors = monitors, seq = contentSeq, same = true, captureMs = captureMs }, null);
            return;
        }
        contentSeq++;
        bool sendPatch = patches && havePrevious && (long)changed.Width * changed.Height < (long)width * height * 2 / 5;
        if (sendPatch)
        {
            byte[] patchJpeg;
            using (Bitmap part = scaledBitmap.Clone(changed, PixelFormat.Format24bppRgb)) patchJpeg = EncodeJpeg(part, quality);
            Frame(3, new { monitor = screen.DeviceName, width = width, height = height, seq = contentSeq, @base = contentSeq - 1,
                patch = new { x = changed.X, y = changed.Y, w = changed.Width, h = changed.Height }, cursorX = cursorX, cursorY = cursorY }, patchJpeg);
        }
        byte[] jpeg = EncodeJpeg(scaledBitmap, quality);
        Frame(2, new {
            monitor = screen.DeviceName, width = width, height = height, desktopWidth = bounds.Width, desktopHeight = bounds.Height,
            cursorX = cursorX, cursorY = cursorY, monitors = monitors, seq = contentSeq, captureMs = captureMs, totalMs = timer.Elapsed.TotalMilliseconds
        }, jpeg);
    }
    static INPUT Mouse(uint flags, uint data = 0, int x = 0, int y = 0)
    { return new INPUT { type = 0, data = new UNION { mouse = new MOUSEINPUT { flags = flags, data = data, dx = x, dy = y } } }; }
    static INPUT Key(ushort vk, uint flags = 0, ushort scan = 0)
    { return new INPUT { type = 1, data = new UNION { key = new KEYBDINPUT { vk = vk, scan = scan, flags = flags } } }; }
    static void Inject(params INPUT[] inputs)
    { if (inputs.Length > 0 && SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new Exception("Windows blocked input. Elevated apps and secure prompts need local interaction."); }
    static void Move(Dictionary<string, object> d)
    {
        Rectangle b = Monitor(d).Bounds, v = SystemInformation.VirtualScreen;
        int px = b.X + (int)Math.Round(Math.Max(0, Math.Min(1, N(d, "x"))) * (b.Width - 1));
        int py = b.Y + (int)Math.Round(Math.Max(0, Math.Min(1, N(d, "y"))) * (b.Height - 1));
        Inject(Mouse(0x8000 | 0x4000 | 1, 0, (int)Math.Round((px - v.X) * 65535.0 / Math.Max(1, v.Width - 1)), (int)Math.Round((py - v.Y) * 65535.0 / Math.Max(1, v.Height - 1))));
    }
    static uint ButtonFlag(string button, bool up) { return button == "right" ? (up ? 0x10u : 8u) : (up ? 4u : 2u); }
    static void Release()
    {
        foreach (string button in Held.ToArray()) { try { Inject(Mouse(ButtonFlag(button, true))); } catch { } }
        Held.Clear();
    }
    static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
        {"Control",17},{"Alt",18},{"Shift",16},{"Meta",91},{"Enter",13},{"Tab",9},{"Escape",27},{"Backspace",8},{"Delete",46},{"Space",32},
        {"ArrowLeft",37},{"ArrowUp",38},{"ArrowRight",39},{"ArrowDown",40},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34}
    };
    static ushort VirtualKey(string name)
    {
        ushort value; if (Keys.TryGetValue(name, out value)) return value;
        if (name.Length == 1 && Char.IsLetterOrDigit(name[0]) && name[0] < 128) return (ushort)Char.ToUpperInvariant(name[0]);
        int f; if (name.StartsWith("F") && Int32.TryParse(name.Substring(1), out f) && f >= 1 && f <= 12) return (ushort)(111 + f);
        throw new Exception("Unsupported key.");
    }
    static uint Extended(ushort key) { return (key >= 33 && key <= 46) || key == 91 ? 1u : 0u; }
    static void Input(Dictionary<string, object> d)
    {
        string op = S(d, "op");
        if (op == "release") { Release(); return; }
        if (!DesktopAvailable()) { Release(); throw new Exception("Windows is locked or showing a secure prompt. Use the PC to continue."); }
        string button = S(d, "button", "left");
        if (op == "move") Move(d);
        else if (op == "click" || op == "double")
        {
            Move(d); for (int i = 0; i < (op == "double" ? 2 : 1); i++) Inject(Mouse(ButtonFlag(button, false)), Mouse(ButtonFlag(button, true)));
        }
        else if (op == "down") { Move(d); Inject(Mouse(ButtonFlag(button, false))); Held.Add(button); }
        else if (op == "up") { Move(d); Inject(Mouse(ButtonFlag(button, true))); Held.Remove(button); }
        else if (op == "scroll")
        {
            Move(d); int delta = (int)Math.Max(-1200, Math.Min(1200, N(d, "delta")));
            Inject(Mouse(S(d,"axis") == "horizontal" ? 0x1000u : 0x800u, unchecked((uint)delta)));
        }
        else if (op == "text")
        {
            string text = S(d, "text"); if (text.Length > 4096) throw new Exception("Text is too long.");
            var keys = new List<INPUT>(); foreach (char c in text) { keys.Add(Key(0, 4, c)); keys.Add(Key(0, 6, c)); } Inject(keys.ToArray());
        }
        else if (op == "key")
        {
            var names = (System.Collections.IEnumerable)d["keys"]; var keys = new List<ushort>();
            foreach (object name in names) keys.Add(VirtualKey(Convert.ToString(name)));
            if (keys.Count > 5) throw new Exception("Too many keys.");
            var inputs = new List<INPUT>(); foreach (ushort key in keys) inputs.Add(Key(key, Extended(key)));
            keys.Reverse(); foreach (ushort key in keys) inputs.Add(Key(key, Extended(key) | 2)); Inject(inputs.ToArray());
        }
        else throw new Exception("Unknown operation.");
    }
    static readonly object CaptureGate = new object();
    static Dictionary<string, object> pendingCapture;
    static void CaptureLoop()
    {
        while (true)
        {
            Dictionary<string, object> d;
            lock (CaptureGate)
            {
                while (pendingCapture == null) System.Threading.Monitor.Wait(CaptureGate);
                d = pendingCapture; pendingCapture = null;     // newest request wins
            }
            try { Capture(d); }
            catch (Exception e) { previousKey = ""; Message(new { id = 0, capture = true, error = e.Message }); }
        }
    }
    // ---------- text-box detection (UI Automation; read-only, no input) ----------
    static int lastEditable = -1;
    static bool IsEditable(AutomationElement element)
    {
        if (element == null) return false;
        AutomationElement.AutomationElementInformation info = element.Current;
        if (!info.IsEnabled || !info.IsKeyboardFocusable) return false;
        ControlType type = info.ControlType; object pattern;
        if (type == ControlType.Edit)
            return !element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || !((ValuePattern)pattern).Current.IsReadOnly;
        if (type == ControlType.Document || type == ControlType.ComboBox || type == ControlType.Custom || type == ControlType.Pane)
        {
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return !((ValuePattern)pattern).Current.IsReadOnly;
            // Word, WordPad and similar editors are Documents with a text pattern; a web page is a Document too, so browsers are left out.
            string framework = info.FrameworkId ?? "";
            return type == ControlType.Document && element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)
                && framework != "Chrome" && framework != "Gecko";
        }
        return false;
    }
    static void ReportFocus(AutomationElement element)
    {
        bool editable = false;
        try { editable = IsEditable(element); } catch { }
        int value = editable ? 1 : 0;
        if (Interlocked.Exchange(ref lastEditable, value) != value) Message(new { focus = true, editable = editable });
    }
    static void WatchFocus()
    {
        try
        {
            Automation.AddAutomationFocusChangedEventHandler((sender, e) => ReportFocus(sender as AutomationElement));
            ReportFocus(AutomationElement.FocusedElement);
        }
        catch (Exception e) { Message(new { focus = true, editable = false, error = e.Message }); }
    }
    static void Probe(Dictionary<string, object> d)
    {
        bool editable = false;
        try
        {
            Rectangle b = Monitor(d).Bounds;
            var point = new System.Windows.Point(b.X + Math.Max(0, Math.Min(1, N(d, "x"))) * (b.Width - 1), b.Y + Math.Max(0, Math.Min(1, N(d, "y"))) * (b.Height - 1));
            AutomationElement element = AutomationElement.FromPoint(point);
            editable = IsEditable(element);
            if (!editable && element != null && element.Current.ControlType == ControlType.Text)
                editable = IsEditable(TreeWalker.ControlViewWalker.GetParent(element));
        }
        catch { }
        Message(new { probe = N(d, "id"), editable = editable });
    }

    [STAThread] static void Main()
    {
        try { SetProcessDpiAwareness(2); } catch { SetProcessDPIAware(); }
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        new Thread(CaptureLoop) { IsBackground = true, Name = "capture" }.Start();
        // UI Automation must not run on this STA thread (it blocks reading stdin and pumps no messages).
        var focusThread = new Thread(WatchFocus) { IsBackground = true, Name = "focus" }; focusThread.SetApartmentState(ApartmentState.MTA); focusThread.Start();
        Message(new { ready = true, inputSize = Marshal.SizeOf(typeof(INPUT)), threaded = true, patches = true, focus = true });
        string line;
        try
        {
            while ((line = Console.ReadLine()) != null)
            {
                Dictionary<string, object> d = null;
                try
                {
                    lock (Json) d = Json.Deserialize<Dictionary<string, object>>(line);
                    if (S(d, "op") == "capture") { lock (CaptureGate) { pendingCapture = d; System.Threading.Monitor.PulseAll(CaptureGate); } }
                    else if (S(d, "op") == "probe") { var probe = d; ThreadPool.QueueUserWorkItem(_ => Probe(probe)); }
                    else { Input(d); Message(new { id = N(d, "id"), ok = true }); }
                }
                catch (Exception e) { Message(new { id = d == null ? 0 : N(d, "id"), capture = d != null && S(d, "op") == "capture", error = e.Message }); }
            }
        }
        finally { Release(); }
    }
}
