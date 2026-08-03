import { initTableBuilder, getSelectedColumns } from './tableBuilder.js';
import { initSorting, getSortingConfig, getFilterConfig, updateAvailableColumns } from './sorting.js';
import { initPreview, refreshPreview } from './preview.js';
import { initExport, updateExportContext } from './wordExport.js';
import { saveTokens, startSync, getEmployeeCount, getEmployees } from './api.js';
import { FIELD_GROUPS, getFieldValue } from './fieldMappings.js';

class App {
  constructor() {
    this.toastContainer = document.getElementById('toast-container');
    this.modalOverlay = document.getElementById('modal-overlay');
    this.currentStaffFilter = 'all';
    this.empCodeSortAsc = true;
    this.empCodeSortActive = false;
    this.currentPage = 1;
    this.pageSize = 50;
    this.currentEmployees = [];
    this.searchQuery = '';
    
    this.initNavigation();
    this.initDashboard();
    
    const tblContainer = document.getElementById('table-builder-container');
    initTableBuilder(tblContainer, (cols) => this.onColumnsChanged(cols));
    
    const sortContainer = document.getElementById('sorting-container');
    initSorting(
      sortContainer, 
      (sorts) => this.onSortingChanged(sorts),
      (filters) => this.onFilterChanged(filters)
    );
    
    const previewContainer = document.getElementById('preview-container');
    initPreview(previewContainer);
    
    const exportContainer = document.getElementById('export-container');
    initExport(exportContainer);
  }

  initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.section');

    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = item.getAttribute('href').substring(1);
        
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
        
        sections.forEach(sec => sec.classList.remove('active'));
        document.getElementById(targetId).classList.add('active');
        
        if (targetId === 'preview-export') {
          const staffType = this.currentStaffFilter === 'all' ? null : this.currentStaffFilter;
          refreshPreview(getSelectedColumns(), getSortingConfig(), getFilterConfig(), staffType);
          updateExportContext(getSelectedColumns(), getSortingConfig(), getFilterConfig(), staffType);
        }
      });
    });
  }

  initDashboard() {
    const btnSync = document.getElementById('btn-start-sync');
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        const bearer = document.getElementById('bearer-token').value;
        const ut = document.getElementById('ut-token').value;
        
        if (!bearer || !ut) {
          this.showToast('الرجاء إدخال رموز المصادقة', 'warning');
          return;
        }

        try {
          await saveTokens(bearer, ut);
          this.startSyncProcess();
        } catch (err) {
          this.showToast('فشل حفظ الرموز: ' + err.message, 'error');
        }
      });
    }
    
    // Staff type filter
    document.querySelectorAll('input[name="staffFilter"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.currentStaffFilter = e.target.value;
        this.currentPage = 1;
        this.fetchAndRenderEmployeeList();
      });
    });

    // Sort button - simple toggle
    const btnSort = document.getElementById('btn-sort-emp-code');
    if (btnSort) {
      btnSort.addEventListener('click', () => {
        if (!this.empCodeSortActive) {
          this.empCodeSortActive = true;
          this.empCodeSortAsc = true;
        } else if (this.empCodeSortAsc) {
          this.empCodeSortAsc = false;
        } else {
          this.empCodeSortActive = false;
        }
        this.updateSortButton(btnSort);
        this.renderEmployeeList();
      });
    }

    // Search
    const searchInput = document.getElementById('emp-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim();
        this.currentPage = 1;
        this.renderEmployeeList();
      });
    }
    
    this.updateStats();
    this.fetchAndRenderEmployeeList();
  }

  updateSortButton(btn) {
    if (this.empCodeSortActive) {
      btn.classList.add('active');
      btn.textContent = this.empCodeSortAsc ? 'ترتيب بالكود (تصاعدي)' : 'ترتيب بالكود (تنازلي)';
    } else {
      btn.classList.remove('active');
      btn.textContent = 'ترتيب بالكود';
    }
  }
  
  async updateStats() {
    try {
      const res = await getEmployeeCount();
      const totalEl = document.getElementById('stat-emp-total');
      const coreEl = document.getElementById('stat-emp-core');
      const secondedEl = document.getElementById('stat-emp-seconded');
      if (totalEl) totalEl.textContent = res.total || res.count || 0;
      if (coreEl) coreEl.textContent = res.core || 0;
      if (secondedEl) secondedEl.textContent = res.seconded || 0;
    } catch(err) {
      console.error(err);
    }
  }

  async fetchAndRenderEmployeeList() {
    const container = document.getElementById('employee-list-container');
    if (!container) return;

    container.innerHTML = '<p class="text-muted text-center"><span class="spinner"></span> جاري تحميل القائمة...</p>';

    try {
      const staffType = this.currentStaffFilter === 'all' ? undefined : this.currentStaffFilter;
      this.currentEmployees = await getEmployees(staffType) || [];
      this.currentPage = 1;
      this.renderEmployeeList();
    } catch (err) {
      console.error('Failed to load employees:', err);
      container.innerHTML = '<p class="text-muted text-center">فشل تحميل القائمة.</p>';
    }
  }

  normalizeArabic(str) {
    return str
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي')
      .toLowerCase();
  }

  renderEmployeeList() {
    const container = document.getElementById('employee-list-container');
    if (!container) return;
    
    let employees = [...this.currentEmployees];

    if (!employees || employees.length === 0) {
      container.innerHTML = '<p class="text-muted text-center">لا توجد بيانات. قم بمزامنة البيانات أولاً.</p>';
      return;
    }

    // Search filter
    if (this.searchQuery) {
      const q = this.normalizeArabic(this.searchQuery);
      employees = employees.filter(emp => {
        const name = this.normalizeArabic(emp.full_name || '');
        const code = String(emp.emp_code || '');
        const natId = String(emp.national_id || '');
        return name.includes(q) || code.includes(this.searchQuery) || natId.includes(this.searchQuery);
      });
    }

    // Sort
    if (this.empCodeSortActive) {
      const dir = this.empCodeSortAsc ? 1 : -1;
      employees.sort((a, b) => {
        const codeA = Number(a.emp_code || 0);
        const codeB = Number(b.emp_code || 0);
        return (codeA - codeB) * dir;
      });
    }

    const totalPages = Math.max(1, Math.ceil(employees.length / this.pageSize));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    if (this.currentPage < 1) this.currentPage = 1;

    const startIdx = (this.currentPage - 1) * this.pageSize;
    const endIdx = startIdx + this.pageSize;
    const paginatedEmployees = employees.slice(startIdx, endIdx);

    let html = `
      <div class="emp-table-scroll">
        <table class="emp-table">
          <thead>
            <tr>
              <th>#</th>
              <th>كود الموظف</th>
              <th>الاسم بالكامل</th>
              <th>الرقم القومي</th>
              <th>الحالة</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
    `;

    if (paginatedEmployees.length === 0) {
      html += '<tr><td colspan="6" style="text-align:center; padding:2rem;">لا توجد نتائج مطابقة للبحث</td></tr>';
    }

    paginatedEmployees.forEach((emp, idx) => {
      const staffBadge = (emp.staff_type === 'seconded') 
        ? '<span class="badge badge-seconded">منتدب</span>' 
        : '<span class="badge badge-core">أساسي</span>';
      
      html += `
        <tr>
          <td>${startIdx + idx + 1}</td>
          <td><strong>${emp.emp_code || ''}</strong></td>
          <td>${emp.full_name || ''} ${staffBadge}</td>
          <td>${emp.national_id || ''}</td>
          <td>${(emp.raw_data?.basicInfo?.genderDesc) || ''}</td>
          <td class="emp-actions">
            <button class="btn-icon" onclick="window.app.showEmployeeDetails(${emp.emp_code})" title="عرض البيانات">👁</button>
            <button class="btn-icon" onclick="window.app.downloadCertificate(${emp.emp_code})" title="إصدار صحيفة">📄</button>
          </td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
      <div class="pagination-bar">
        <span class="text-muted small">إجمالي: ${employees.length} | صفحة ${this.currentPage} من ${totalPages}</span>
        <div class="pagination-btns">
          <button class="btn btn-sm btn-outline" id="btn-prev-page" ${this.currentPage === 1 ? 'disabled' : ''}>السابق</button>
          <button class="btn btn-sm btn-outline" id="btn-next-page" ${this.currentPage >= totalPages ? 'disabled' : ''}>التالي</button>
        </div>
      </div>
    `;
    container.innerHTML = html;

    // Pagination events
    document.getElementById('btn-prev-page')?.addEventListener('click', () => {
      if (this.currentPage > 1) { this.currentPage--; this.renderEmployeeList(); }
    });
    document.getElementById('btn-next-page')?.addEventListener('click', () => {
      if (this.currentPage < totalPages) { this.currentPage++; this.renderEmployeeList(); }
    });
  }

  showEmployeeDetails(empCode) {
    const emp = this.currentEmployees.find(e => Number(e.emp_code) === Number(empCode));
    if (!emp) { this.showToast('لم يتم العثور على الموظف', 'error'); return; }

    const data = emp.raw_data || {};
    let fieldId = 0;
    
    const makeField = (label, value) => {
      if (!value && value !== 0) return '';
      const id = `copy-field-${fieldId++}`;
      return `
        <div class="detail-field">
          <label class="detail-field-label">${label}</label>
          <div class="detail-field-row">
            <input type="text" class="detail-field-input" id="${id}" value="${String(value).replace(/"/g, '&quot;')}" readonly>
            <button class="detail-copy-btn" data-target="${id}" title="نسخ">
              <svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              <svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="display:none;"><path d="M20 6L9 17l-5-5"/></svg>
            </button>
          </div>
        </div>`;
    };

    let html = `
        <div class="emp-detail-header">
          <h2>${emp.full_name || ''}</h2>
          <button class="close-modal btn-icon" style="font-size:1.5rem;">&times;</button>
        </div>
        <div class="emp-detail-body">
    `;

    for (const [groupKey, group] of Object.entries(FIELD_GROUPS)) {
      // Only show secondment section for seconded employees
      if (groupKey === 'secondment' && emp.staff_type !== 'seconded') continue;
      
      let groupHtml = '';
      for (const [fieldPath, info] of Object.entries(group.fields)) {
        const val = getFieldValue(data, fieldPath);
        groupHtml += makeField(info.label, val);
      }
      if (groupHtml) {
        html += `<div class="detail-section">
          <div class="detail-section-title">${group.icon || ''} ${group.label}</div>
          <div class="detail-fields-grid">${groupHtml}</div>
        </div>`;
      }
    }

    // Show any raw keys not in mappings
    const shownKeys = new Set();
    for (const group of Object.values(FIELD_GROUPS)) {
      for (const fp of Object.keys(group.fields)) {
        shownKeys.add(fp.split('.')[0]);
      }
    }

    for (const [key, val] of Object.entries(data)) {
      if (shownKeys.has(key) || key === 'secondment') continue;
      if (typeof val === 'object' && val !== null) {
        const entries = Array.isArray(val) ? (val[0] || {}) : val;
        const items = Object.entries(entries).filter(([,v]) => v != null && v !== '' && v !== 0);
        if (items.length > 0) {
          let groupHtml = '';
          for (const [k, v] of items) {
            groupHtml += makeField(k, v);
          }
          html += `<div class="detail-section">
            <div class="detail-section-title">${key}</div>
            <div class="detail-fields-grid">${groupHtml}</div>
          </div>`;
        }
      }
    }

    html += '</div>';
    this.showModal(html, 'emp-detail-modal');

    // Attach copy handlers
    document.querySelectorAll('.detail-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        navigator.clipboard.writeText(input.value).then(() => {
          const copyIcon = btn.querySelector('.copy-icon');
          const checkIcon = btn.querySelector('.check-icon');
          copyIcon.style.display = 'none';
          checkIcon.style.display = 'block';
          btn.classList.add('copied');
          setTimeout(() => {
            copyIcon.style.display = 'block';
            checkIcon.style.display = 'none';
            btn.classList.remove('copied');
          }, 1500);
        });
      });
    });
  }

  async downloadCertificate(empCode) {
    const emp = this.currentEmployees.find(e => Number(e.emp_code) === Number(empCode));
    const empName = emp ? emp.full_name : empCode;
    
    this.showToast('جاري تحميل الصحيفة...', 'info');
    
    try {
      const response = await fetch(`/api/certificate/${empCode}`);
      if (!response.ok) throw new Error('فشل تحميل الصحيفة');
      
      const contentType = response.headers.get('content-type') || '';
      const today = new Date().toISOString().split('T')[0];

      if (contentType.includes('application/json')) {
        const jsonData = await response.json();
        // If the API returns a file URL or data
        if (jsonData.data) {
          const blob = new Blob([JSON.stringify(jsonData.data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${empName}_صحيفة_${today}.json`;
          a.click();
          URL.revokeObjectURL(url);
        }
      } else {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ext = contentType.includes('pdf') ? 'pdf' : contentType.includes('sheet') ? 'xlsx' : 'bin';
        a.download = `${empName}_صحيفة_${today}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
      }
      
      this.showToast('تم تحميل الصحيفة بنجاح', 'success');
    } catch (err) {
      this.showToast('خطأ: ' + err.message, 'error');
    }
  }

  startSyncProcess() {
    const pbContainer = document.getElementById('sync-progress-container');
    const pbFill = document.getElementById('sync-progress-fill');
    const pbText = document.getElementById('sync-progress-text');
    const btnSync = document.getElementById('btn-start-sync');
    
    pbContainer.style.display = 'block';
    btnSync.disabled = true;
    pbFill.style.width = '0%';
    
    startSync(
      (data) => {
        if (data.current && data.total) {
          pbFill.style.width = `${Math.round((data.current / data.total) * 100)}%`;
        }
        pbText.textContent = data.message;
      },
      (data) => {
        pbFill.style.width = '100%';
        pbFill.style.backgroundColor = 'var(--success)';
        pbText.textContent = 'تم المزامنة بنجاح!';
        btnSync.disabled = false;
        this.showToast('اكتملت مزامنة البيانات', 'success');
        this.updateStats();
        this.fetchAndRenderEmployeeList();
        setTimeout(() => { pbContainer.style.display = 'none'; pbFill.style.backgroundColor = ''; }, 3000);
      },
      (err) => {
        pbFill.style.backgroundColor = 'var(--danger)';
        pbText.textContent = 'خطأ: ' + err.message;
        btnSync.disabled = false;
        this.showToast('خطأ أثناء المزامنة', 'error');
      }
    );
  }

  onColumnsChanged(columns) {
    updateAvailableColumns(columns);
  }

  onSortingChanged(sorting) {}
  onFilterChanged(filters) {}

  // UI Utilities
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = '⚠️';
    
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-message">${message}</span>`;
    
    this.toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  showModal(htmlContent, customClass = '') {
    const modalContent = document.createElement('div');
    modalContent.className = `modal-content card ${customClass}`;
    modalContent.innerHTML = htmlContent;
    
    this.modalOverlay.innerHTML = '';
    this.modalOverlay.appendChild(modalContent);
    this.modalOverlay.classList.add('active');
    
    const closeBtn = modalContent.querySelector('.close-modal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closeModal());
    }
    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this.closeModal();
    });
  }

  closeModal() {
    this.modalOverlay.classList.remove('active');
    setTimeout(() => { this.modalOverlay.innerHTML = ''; }, 300);
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
