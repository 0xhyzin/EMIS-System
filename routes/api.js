import express from 'express';
import { parseUtToken } from '../utils/tokenParser.js';
import * as db from '../db/database.js';

const router = express.Router();

router.post('/auth/tokens', (req, res) => {
    try {
        const { bearerToken, utToken } = req.body;
        if (!bearerToken || !utToken) {
            return res.status(400).json({ success: false, message: 'Missing tokens' });
        }

        db.saveSetting('bearerToken', bearerToken);
        db.saveSetting('utToken', utToken);

        const schoolInfo = parseUtToken(utToken);
        db.saveSetting('schoolInfo', schoolInfo);

        res.json({ success: true, schoolInfo });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/auth/tokens', (req, res) => {
    try {
        const bearerToken = db.getSetting('bearerToken');
        const utToken = db.getSetting('utToken');
        const schoolInfo = db.getSetting('schoolInfo');

        res.json({ bearerToken, utToken, schoolInfo });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/sync/start', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const bearerToken = db.getSetting('bearerToken');
        const utToken = db.getSetting('utToken');
        const schoolInfo = db.getSetting('schoolInfo');

        if (!bearerToken || !utToken || !schoolInfo) {
            throw new Error('Tokens or school info not configured. Please save tokens first.');
        }

        sendEvent({ step: 'fetching_list', message: 'جاري جلب قائمة القوة الأساسية...' });

        const { ty, sc, ed } = schoolInfo;
        let cleanBearer = bearerToken.trim();
        if (cleanBearer.toLowerCase().startsWith('bearer ')) {
            cleanBearer = cleanBearer.substring(7).trim();
        }

        const headers = {
            'Authorization': `Bearer ${cleanBearer}`,
            'Ut': utToken,
            'Ty': String(ty),
            'Sc': String(sc),
            'Ed': String(ed),
            'Md': '0',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            'Origin': 'https://teacher.emis.gov.eg',
            'Referer': 'https://teacher.emis.gov.eg/'
        };

        const listBody = {
            draw: 1,
            columns: [],
            order: [],
            start: 0,
            length: 500,
            search: { value: "", regex: false },
            empFlagCode: 1,
            EdaraCode: Number(ed),
            schoolCode: Number(sc)
        };

        const listRes = await fetch('https://professopi.emis.gov.eg/api/Employee/GetEmployeeByEmpFlag', {
            method: 'POST',
            headers,
            body: JSON.stringify(listBody)
        });

        if (!listRes.ok) {
            throw new Error(`Failed to fetch employee list: ${listRes.status} ${listRes.statusText}`);
        }

        const listData = await listRes.json();
        const coreEmployees = listData.data || [];
        
        sendEvent({ step: 'fetching_list_seconded', message: 'جاري جلب قائمة المنتدبين...' });

        const secondedBody = {
            draw: 1,
            columns: [],
            order: [],
            start: 0,
            length: 500,
            search: { value: "", regex: false },
            userType: 4,
            GehaCode: Number(sc)
        };

        const secondedRes = await fetch('https://professopi.emis.gov.eg/api/Employee/EmployeesNadb', {
            method: 'POST',
            headers,
            body: JSON.stringify(secondedBody)
        });

        if (!secondedRes.ok) {
            throw new Error(`Failed to fetch seconded employee list: ${secondedRes.status} ${secondedRes.statusText}`);
        }

        const secondedData = await secondedRes.json();
        const secondedEmployees = secondedData.data || [];

        // Identify seconded employee codes to exclude them from core list
        const secondedCodes = new Set(secondedEmployees.map(emp => emp.empCode));
        const filteredCoreEmployees = coreEmployees.filter(emp => !secondedCodes.has(emp.empCode));

        const allListEmployees = [
            ...filteredCoreEmployees.map(emp => ({ ...emp, _staffType: 'core' })),
            ...secondedEmployees.map(emp => ({ ...emp, _staffType: 'seconded' }))
        ];

        const total = allListEmployees.length;

        for (let i = 0; i < total; i++) {
            const empItem = allListEmployees[i];
            const empCode = empItem.empCode;
            const staffType = empItem._staffType;
            
            sendEvent({ 
                step: 'fetching_details', 
                current: i + 1, 
                total, 
                message: `جاري جلب بيانات الموظف ${i + 1} من ${total}...` 
            });

            const detailRes = await fetch('https://professopi.emis.gov.eg/api/Employee/GetEmployeeFullData', {
                method: 'POST',
                headers,
                body: JSON.stringify({ empCode })
            });

            if (detailRes.ok) {
                const fullData = await detailRes.json();
                const basicInfo = fullData.basicInfo || {};
                const nationalIdNum = basicInfo.nationalIdNum || '';
                const fullName = [
                    basicInfo.empFirstName,
                    basicInfo.empFatherName,
                    basicInfo.empGrandFatherName,
                    basicInfo.empFamilyName
                ].filter(Boolean).join(' ');

                if (staffType === 'seconded') {
                    fullData.secondment = {
                        empFlag: empItem.empFlag || '',
                        fromMudriaName: empItem.fromMudriaName || '',
                        fromEdaraName: empItem.fromEdaraName || '',
                        fromGehaName: empItem.fromGehaName || '',
                        toMudriaName: empItem.toMudriaName || '',
                        toEdaraName: empItem.toEdaraName || '',
                        toGehaName: empItem.toGehaName || '',
                        jobName: empItem.jobName || ''
                    };
                }

                db.upsertEmployee(empCode, nationalIdNum, fullName, fullData, staffType);
            }
        }

        sendEvent({ step: 'updating_references', message: 'جاري تحديث القوائم المرجعية...' });
        
        db.clearReferenceValues();
        const allSaved = db.getAllEmployees();
        
        const enumMapping = [
            { path: 'basicInfo.genderDesc', label: 'النوع' },
            { path: 'basicInfo.empReligion', label: 'الديانة' },
            { path: 'basicInfo.martStatDesc', label: 'الحالة الاجتماعية' },
            { path: 'basicInfo.recruitmentTypeDesc', label: 'نوع التعيين' },
            { path: 'basicInfo.stageName', label: 'المرحلة' },
            { path: 'qlf.qlfName', label: 'المؤهل' },
            { path: 'qlf.qlfTypeName', label: 'نوع المؤهل' },
            { path: 'qlf.qlfEntityName', label: 'جهة التخرج' },
            { path: 'qlf.qlfGradDesc', label: 'تقدير المؤهل' },
            { path: 'job.degreeDesc', label: 'الدرجة الوظيفية' },
            { path: 'job.jobClassDesc', label: 'المجموعة النوعية' },
            { path: 'job.jobDesc', label: 'الوظيفة على الكادر' },
            { path: 'job.subjectDesc', label: 'المادة/التخصص' },
            { path: 'job.stageDesc', label: 'المرحلة الدراسية' }
        ];

        for (const empRow of allSaved) {
            const data = empRow.raw_data;
            for (const field of enumMapping) {
                const [section, prop] = field.path.split('.');
                let val = null;
                if (data[section]) {
                    if (Array.isArray(data[section])) {
                        if (data[section].length > 0) val = data[section][0][prop];
                    } else {
                        val = data[section][prop];
                    }
                }
                if (val) {
                    db.addReferenceValue(field.path, field.label, String(val).trim());
                }
            }
        }

        sendEvent({ step: 'done', message: 'تم تحديث البيانات بنجاح', totalEmployees: total });
        res.end();
    } catch (error) {
        console.error("Sync error:", error);
        sendEvent({ step: 'error', message: error.message || 'حدث خطأ غير متوقع' });
        res.end();
    }
});

router.get('/employees', (req, res) => {
    try {
        const employees = db.getAllEmployees(req.query.staffType);
        const fieldsStr = req.query.fields;
        
        if (fieldsStr) {
            const fields = fieldsStr.split(',');
            const filtered = employees.map(emp => {
                const obj = {};
                if (fields.includes('empCode')) obj.empCode = emp.emp_code;
                if (fields.includes('fullName')) obj.fullName = emp.full_name;
                if (fields.includes('nationalId')) obj.nationalId = emp.national_id;
                return obj;
            });
            return res.json(filtered);
        }
        
        res.json(employees);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/employees/count', (req, res) => {
    try {
        const stats = db.getEmployeeCount();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/employees/:empCode', (req, res) => {
    try {
        const emp = db.getEmployee(req.params.empCode);
        if (!emp) return res.status(404).json({ error: 'Employee not found' });
        res.json(emp);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/reference', (req, res) => {
    try {
        const fields = db.getAllReferenceFields();
        const result = fields.map(f => ({
            key: f.field_key,
            label: f.field_label,
            values: db.getReferenceValues(f.field_key)
        }));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/reference/:fieldKey', (req, res) => {
    try {
        const values = db.getReferenceValues(req.params.fieldKey);
        res.json(values);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/reference/:fieldKey/order', (req, res) => {
    try {
        const { values } = req.body;
        if (!Array.isArray(values)) {
            return res.status(400).json({ error: 'Values must be an array' });
        }
        db.updateReferenceOrder(req.params.fieldKey, values);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/table-config', (req, res) => {
    try {
        const { name, columns, sorting, footer, title } = req.body;
        const id = db.saveTableConfig(name, columns, sorting, footer, title);
        res.json({ success: true, id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/table-config', (req, res) => {
    try {
        res.json(db.getTableConfigs());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/table-config/:id', (req, res) => {
    try {
        const config = db.getTableConfig(req.params.id);
        if (!config) return res.status(404).json({ error: 'Not found' });
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/table-config/:id', (req, res) => {
    try {
        db.deleteTableConfig(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/certificate/:empCode', async (req, res) => {
    try {
        const bearerToken = db.getSetting('bearerToken');
        const utToken = db.getSetting('utToken');
        const schoolInfo = db.getSetting('schoolInfo');

        if (!bearerToken || !utToken || !schoolInfo) {
            return res.status(400).json({ error: 'Tokens not configured' });
        }

        const { ty, sc, ed } = schoolInfo;
        let cleanBearer = bearerToken.trim();
        if (cleanBearer.toLowerCase().startsWith('bearer ')) {
            cleanBearer = cleanBearer.substring(7).trim();
        }

        const headers = {
            'Authorization': `Bearer ${cleanBearer}`,
            'Ut': utToken,
            'Ty': String(ty),
            'Sc': String(sc),
            'Ed': String(ed),
            'Md': '0',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            'Origin': 'https://teacher.emis.gov.eg',
            'Referer': 'https://teacher.emis.gov.eg/',
            'Accept': 'application/json, text/plain, */*'
        };

        const empCode = req.params.empCode;
        const certRes = await fetch(`https://professopi.emis.gov.eg/api/Employee/CRevisionNew01?EmpCode=${empCode}`, {
            method: 'GET',
            headers
        });

        if (!certRes.ok) {
            throw new Error(`Failed to fetch certificate: ${certRes.status}`);
        }

        const contentType = certRes.headers.get('content-type') || '';
        
        // Get employee name for filename
        const emp = db.getEmployee(Number(empCode));
        const empName = emp ? emp.full_name : empCode;
        const today = new Date().toISOString().split('T')[0];
        
        if (contentType.includes('application/json')) {
            const jsonData = await certRes.json();
            res.json({ data: jsonData, fileName: `${empName}_صحيفة_${today}` });
        } else {
            // Binary file (PDF, etc.)
            const buffer = await certRes.arrayBuffer();
            const ext = contentType.includes('pdf') ? 'pdf' : 'xlsx';
            const fileName = `${empName}_صحيفة_${today}.${ext}`;
            
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
            res.setHeader('Content-Type', contentType);
            res.send(Buffer.from(buffer));
        }
    } catch (error) {
        console.error('Certificate error:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
