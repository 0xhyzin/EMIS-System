import { getEmployees } from './api.js';
import { getFieldValue } from './fieldMappings.js';

let currentData = [];
let currentColumns = [];
let currentSorting = [];
let currentFilters = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 50;

export function initPreview(container) {
  container.innerHTML = `
    <div class="preview-layout">
      <div class="card preview-header">
        <div class="d-flex justify-content-between align-items-center">
          <h3>معاينة الجدول</h3>
          <div class="preview-stats">
            <span id="preview-count" class="badge badge-primary">0 موظف</span>
          </div>
        </div>
      </div>
      
      <div class="card table-container-card">
        <div class="table-responsive">
          <table class="data-table" id="preview-table">
            <thead><tr id="preview-thead-row"></tr></thead>
            <tbody id="preview-tbody"></tbody>
          </table>
        </div>
        
        <div class="pagination-controls" id="preview-pagination">
           <button class="btn btn-outline" id="btn-prev-page" disabled>السابق</button>
           <span class="page-info" id="page-info">صفحة 1 من 1</span>
           <button class="btn btn-outline" id="btn-next-page" disabled>التالي</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderTableData();
    }
  });
  
  document.getElementById('btn-next-page').addEventListener('click', () => {
    const maxPage = Math.ceil(currentData.length / ITEMS_PER_PAGE);
    if (currentPage < maxPage) {
      currentPage++;
      renderTableData();
    }
  });
}

export async function refreshPreview(columns, sorting, filters) {
  currentColumns = columns;
  currentSorting = sorting || [];
  currentFilters = filters || [];
  
  if (!currentColumns || currentColumns.length === 0) {
    document.getElementById('preview-thead-row').innerHTML = '<th>يرجى اختيار أعمدة للجدول</th>';
    document.getElementById('preview-tbody').innerHTML = '';
    return;
  }
  
  renderTableHeader();
  
  try {
    document.getElementById('preview-tbody').innerHTML = `<tr><td colspan="${currentColumns.length}" class="text-center p-4"><div class="spinner"></div> جاري تحميل البيانات...</td></tr>`;
    
    const data = await getEmployees();
    
    // Apply filters
    let filteredData = applyFilters(data, currentFilters);
    
    // Sort Data
    currentData = sortData(filteredData, currentSorting);
    currentPage = 1;
    
    document.getElementById('preview-count').textContent = `${currentData.length} موظف`;
    
    renderTableData();
  } catch (error) {
    document.getElementById('preview-tbody').innerHTML = `<tr><td colspan="${currentColumns.length}" class="text-center text-danger p-4">خطأ في تحميل البيانات: ${error.message}</td></tr>`;
  }
}

function applyFilters(data, filters) {
  if (!filters || filters.length === 0) return data;
  
  return data.filter(emp => {
    for (const filter of filters) {
      if (!filter.path || !filter.values || filter.values.length === 0) continue;
      
      const val = String(getFieldValue(emp, filter.path)).trim();
      
      if (filter.mode === 'exclude') {
        if (filter.values.includes(val)) return false;
      } else {
        // include mode
        if (!filter.values.includes(val)) return false;
      }
    }
    return true;
  });
}

function sortData(data, sortingConfig) {
  if (!sortingConfig || sortingConfig.length === 0) return data;
  
  return [...data].sort((a, b) => {
    for (const sort of sortingConfig) {
      const valA = getFieldValue(a, sort.path);
      const valB = getFieldValue(b, sort.path);
      
      if (valA === valB) continue; // Move to next sort level

      // Custom enum ordering
      if (sort.direction === 'custom' && sort.customOrder) {
        const idxA = sort.customOrder.indexOf(String(valA));
        const idxB = sort.customOrder.indexOf(String(valB));
        const finalA = idxA === -1 ? 999999 : idxA;
        const finalB = idxB === -1 ? 999999 : idxB;
        const diff = finalA - finalB;
        if (diff !== 0) return diff;
        continue;
      }
      
      let comp = 0;
      if (sort.type === 'number') {
        comp = (parseFloat(valA) || 0) - (parseFloat(valB) || 0);
      } else if (sort.type === 'date') {
        comp = new Date(valA).getTime() - new Date(valB).getTime();
      } else {
        comp = String(valA).localeCompare(String(valB), 'ar');
      }
      
      if (comp !== 0) {
        return sort.direction === 'desc' ? -comp : comp;
      }
    }
    return 0;
  });
}

function renderTableHeader() {
  const row = document.getElementById('preview-thead-row');
  row.innerHTML = currentColumns.map(col => `<th>${col.label}</th>`).join('');
}

function renderTableData() {
  const tbody = document.getElementById('preview-tbody');
  
  if (currentData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${currentColumns.length}" class="text-center p-4">لا توجد بيانات</td></tr>`;
    updatePagination(0);
    return;
  }
  
  const startIdx = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, currentData.length);
  const pageData = currentData.slice(startIdx, endIdx);
  
  tbody.innerHTML = pageData.map((emp, index) => {
    const globalIndex = startIdx + index + 1;
    return `<tr>${currentColumns.map(col => {
      let cellValue = '';
      if (col.isIndex) {
        cellValue = globalIndex;
      } else if (col.isMerged) {
        cellValue = col.parts.map(p => getFieldValue(emp, p.path)).filter(Boolean).join(col.separator || ' ');
      } else {
        cellValue = getFieldValue(emp, col.path);
      }
      return `<td>${cellValue || '-'}</td>`;
    }).join('')}</tr>`;
  }).join('');
  
  updatePagination(currentData.length);
}

function updatePagination(totalItems) {
  const maxPage = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  document.getElementById('page-info').textContent = `صفحة ${currentPage} من ${maxPage}`;
  document.getElementById('btn-prev-page').disabled = currentPage <= 1;
  document.getElementById('btn-next-page').disabled = currentPage >= maxPage;
}
