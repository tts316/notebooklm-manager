import streamlit as st
import pandas as pd
from datetime import datetime
import io
import time
import gspread
from google.oauth2.service_account import Credentials
from gspread.exceptions import APIError

# --- 系統設定 ---
st.set_page_config(page_title="NotebookLM 權限管理", layout="wide", page_icon="VX")

# --- 資料庫核心 ---
class NotebookDB:
    def __init__(self):
        self.connect()

    def connect(self):
        try:
            scope = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
            creds_dict = dict(st.secrets["gcp_service_account"])
            creds = Credentials.from_service_account_info(creds_dict, scopes=scope)
            self.client = gspread.authorize(creds)
            sheet_url = st.secrets["sheet_config"]["spreadsheet_url"]
            self.sh = self.client.open_by_url(sheet_url)
            self.ws_notebooks = self.sh.worksheet("notebooks")
            self.ws_permissions = self.sh.worksheet("permissions")
            self.ws_admin = self.sh.worksheet("system_admin")
        except Exception as e:
            st.error(f"資料庫連線失敗: {e}")
            st.stop()

    def get_df(self, table_name):
        for i in range(3):
            try:
                if table_name == "notebooks": return pd.DataFrame(self.ws_notebooks.get_all_records())
                elif table_name == "permissions": return pd.DataFrame(self.ws_permissions.get_all_records())
            except: time.sleep(1)
        return pd.DataFrame()

    def upsert_notebook(self, nb_id, name, owner):
        try:
            cell = self.ws_notebooks.find(nb_id)
            if cell:
                self.ws_notebooks.update_cell(cell.row, 2, name)
                self.ws_notebooks.update_cell(cell.row, 3, owner)
            else:
                self.ws_notebooks.append_row([nb_id, name, owner, datetime.now().strftime("%Y-%m-%d")])
            return True, f"筆記本 '{name}' 已儲存"
        except Exception as e: return False, str(e)

    def upsert_permission(self, nb_id, email, role):
        try:
            records = self.ws_permissions.get_all_records()
            found_row = None
            for idx, r in enumerate(records):
                if str(r['notebook_id']) == str(nb_id) and str(r['user_email']) == str(email):
                    found_row = idx + 2
                    break
            
            t = datetime.now().strftime("%Y-%m-%d %H:%M")
            if found_row:
                self.ws_permissions.batch_update([{
                    'range': f'C{found_row}:E{found_row}',
                    'values': [[role, "Active", t]]
                }])
            else:
                self.ws_permissions.append_row([nb_id, email, role, "Active", t])
            return True, "權限已更新"
        except Exception as e: return False, str(e)

    def batch_import(self, df_excel, target_nb_id):
        try:
            existing = self.ws_permissions.get_all_records()
            exist_map = {f"{r['notebook_id']}|{r['user_email']}": i for i, r in enumerate(existing)}
            new_rows = []
            for i, row in df_excel.iterrows():
                email = str(row.get("Email", "")).strip()
                role = str(row.get("權限", "Viewer")).strip()
                if not email: continue
                if f"{target_nb_id}|{email}" not in exist_map:
                    new_rows.append([target_nb_id, email, role, "Active", datetime.now().strftime("%Y-%m-%d")])
            if new_rows: self.ws_permissions.append_rows(new_rows)
            return True, f"匯入 {len(new_rows)} 筆"
        except Exception as e: return False, str(e)

    def revoke_permission(self, nb_id, email):
        try:
            records = self.ws_permissions.get_all_records()
            for idx, r in enumerate(records):
                if str(r['notebook_id']) == str(nb_id) and str(r['user_email']) == str(email):
                    self.ws_permissions.update_cell(idx + 2, 4, "Revoked")
                    return True, "已移除"
            return False, "找不到"
        except Exception as e: return False, str(e)

    def verify_login(self, username, password):
        try:
            cell = self.ws_admin.find(username, in_column=1)
            if cell and str(self.ws_admin.cell(cell.row, 2).value) == str(password):
                return True
            return False
        except: return False

@st.cache_resource
def get_db(): return NotebookDB()

try: sys = get_db()
except: st.error("連線失敗"); st.stop()

# --- UI ---
@st.dialog("➕ 新增主題")
def show_add_notebook_dialog():
    with st.form("add"):
        name = st.text_input("主題名稱")
        nid = st.text_input("Notebook ID (網址後的亂碼)")
        if not nid: nid = str(int(time.time()))
        if st.form_submit_button("建立"):
            succ, msg = sys.upsert_notebook(nid, name, st.session_state.user_id)
            if succ: st.success(msg); time.sleep(1); st.rerun()
            else: st.error(msg)

def run_app():
    with st.sidebar:
        st.title("NotebookLM 管理")
        st.write(f"登入: {st.session_state.user_id}")
        if st.button("登出"): st.session_state.logged_in=False; st.rerun()
        st.divider()
        df_nb = sys.get_df("notebooks")
        if not df_nb.empty:
            opts = {f"{r['notebook_name']}": r['notebook_id'] for i,r in df_nb.iterrows()}
            s_name = st.selectbox("📂 選擇主題", list(opts.keys()))
            s_id = opts[s_name]
        else:
            s_id = None; st.warning("請先建立主題")
        st.divider()
        if st.button("➕ 建立新主題"): show_add_notebook_dialog()

    if s_id:
        st.header(f"主題：{s_name}")
        st.caption(f"ID: {s_id}")
        # 直達連結
        url = f"https://notebooklm.google.com/notebook/{s_id}"
        st.link_button("🔗 前往 NotebookLM", url)
        
        st.subheader("👥 分享名單")
        df_p = sys.get_df("permissions")
        if not df_p.empty:
            users = df_p[(df_p['notebook_id'].astype(str)==str(s_id)) & (df_p['status']=="Active")]
            if not users.empty:
                c1, c2 = st.columns(2)
                c1.metric("人數", len(users))
                st.code(",".join(users['user_email'].tolist()), language="text")
                st.caption("⬆️ 複製上方清單貼入 NotebookLM")
                
                # List
                cols = [3, 1.5, 1.5]
                h = st.columns(cols)
                h[0].write("Email"); h[1].write("權限"); h[2].write("操作")
                st.divider()
                for i, r in users.iterrows():
                    c = st.columns(cols, vertical_alignment="center")
                    c[0].write(r['user_email'])
                    c[1].write(r['role'])
                    if c[2].button("移除", key=f"d_{i}"):
                        sys.revoke_permission(s_id, r['user_email']); st.rerun()
                    st.markdown("---")
            else: st.info("無分享對象")
        
        st.divider()
        t1, t2 = st.tabs(["單筆新增", "Excel 匯入"])
        with t1:
            c1, c2, c3 = st.columns([3, 2, 1])
            em = c1.text_input("Email")
            ro = c2.selectbox("權限", ["Viewer", "Editor"])
            if c3.button("新增"):
                if em: sys.upsert_permission(s_id, em, ro); st.success("OK"); time.sleep(1); st.rerun()
        with t2:
            sample = pd.DataFrame([{"Email": "user@example.com", "權限": "Viewer"}])
            buf = io.BytesIO()
            with pd.ExcelWriter(buf, engine='xlsxwriter') as w: sample.to_excel(w, index=False)
            st.download_button("下載範本", buf, "template.xlsx")
            up = st.file_uploader("上傳", type=["xlsx"])
            if up and st.button("匯入"):
                try:
                    sys.batch_import(pd.read_excel(up), s_id)
                    st.success("完成"); time.sleep(1.5); st.rerun()
                except Exception as e: st.error(str(e))
    else: st.info("請從左側建立主題")

if __name__ == "__main__":
    if 'logged_in' not in st.session_state: st.session_state.logged_in=False; st.session_state.user_id=None
    if not st.session_state.logged_in:
        c1, c2, c3 = st.columns([1, 2, 1])
        with c2:
            st.markdown("## 📚 系統登入")
            u = st.text_input("帳號"); p = st.text_input("密碼", type="password")
            if st.button("登入", type="primary", use_container_width=True):
                if sys.verify_login(u, p): st.session_state.logged_in=True; st.session_state.user_id=u; st.rerun()
                else: st.error("錯誤")
    else: run_app()
