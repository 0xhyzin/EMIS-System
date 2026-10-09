export function parseUtToken(utToken) {
    try {
        if (!utToken) {
            throw new Error('Token is missing');
        }

        const parts = utToken.split('.');
        if (parts.length !== 3) {
            throw new Error('Invalid JWT format');
        }

        const payloadStr = Buffer.from(parts[1], 'base64').toString('utf8');
        const payload = JSON.parse(payloadStr);

        const ty = payload.UserTypes;
        if (!payload.userData) {
            throw new Error('Missing userData in token payload');
        }

        const userDataStr = Buffer.from(payload.userData, 'base64').toString('utf8');
        const userData = JSON.parse(userDataStr);

        let sc = null, ed = null, empCode = null;
        if (userData.UserLoginData && userData.UserLoginData.length > 0) {
            const firstUser = userData.UserLoginData[0];
            sc = firstUser.SchoolCode;
            ed = firstUser.EdaraCode;
            empCode = firstUser.EmpCode;
        }

        let schoolName = '', edaraName = '', mudriaName = '';
        if (userData.SchoolsData && userData.SchoolsData.length > 0) {
            const school = sc 
                ? userData.SchoolsData.find(s => String(s.BCH_CODE) === String(sc)) || userData.SchoolsData[0] 
                : userData.SchoolsData[0];
            
            if (school) {
                sc = sc || school.BCH_CODE;
                ed = ed || school.EdaraCode;
                schoolName = school.BCH_DESC || '';
                // rel_desc usually has the edara name
                edaraName = school.rel_desc || '';
                // stage_desc sometimes has the mudria name
                // mudriaCode is just a number, so we look for mudriaName or use a mapping
                mudriaName = school.mudriaName || school.mudriaDesc || school.stage_desc || '';
                
                // If mudriaName is still empty or just a number, try to derive it
                if (!mudriaName || /^\d+$/.test(mudriaName)) {
                    // Common mapping for Egyptian governorates by mudria code
                    const mudriaMap = {
                        '1': 'القاهرة', '2': 'الإسكندرية', '3': 'بورسعيد',
                        '4': 'السويس', '5': 'دمياط', '6': 'الدقهلية',
                        '7': 'الشرقية', '8': 'القليوبية', '9': 'كفر الشيخ',
                        '10': 'الغربية', '11': 'المنوفية', '12': 'البحيرة',
                        '13': 'الإسماعيلية', '14': 'الجيزة', '15': 'بني سويف',
                        '16': 'الفيوم', '17': 'المنيا', '18': 'أسيوط',
                        '19': 'سوهاج', '20': 'قنا', '21': 'أسوان',
                        '22': 'الأقصر', '23': 'البحر الأحمر', '24': 'الوادي الجديد',
                        '25': 'مطروح', '26': 'شمال سيناء', '27': 'جنوب سيناء',
                    };
                    const code = String(school.mudriaCode || '');
                    mudriaName = mudriaMap[code] || mudriaName || code;
                }
            }
        }

        return { ty, sc, ed, empCode, schoolName, edaraName, mudriaName };
    } catch {
        // JSON parser messages can contain fragments of decoded personal data.
        throw new Error('Invalid ministry account token');
    }
}
