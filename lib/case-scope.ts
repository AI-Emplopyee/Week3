import type { CaseType } from './types.ts';

export const CASE_TYPE_LABELS: Record<CaseType, string> = {
  import: 'Nhập khẩu',
  export: 'Xuất khẩu / tái xuất',
  reference: 'Tài liệu tham khảo',
  unknown: 'Cần xác định chiều vận chuyển',
  unsupported: 'Loại khác',
};

/** Stored documents remain accessible even when the import declaration does not apply. */
export function caseScopeMessage(type: CaseType): { title: string; description: string } | null {
  if (type === 'import') return null;
  if (type === 'export') return {
    title: 'Hồ sơ xuất khẩu / tái xuất',
    description: 'Rà soát biểu mẫu xuất khẩu EDA, xác nhận các giá trị và gửi đến máy Windows đã kết nối để tạo bản nháp ECUS.',
  };
  if (type === 'reference') return {
    title: 'Bộ tài liệu tham khảo',
    description: 'Đây là tài liệu hỗ trợ, hình ảnh hoặc hồ sơ lịch sử để tra cứu. Không yêu cầu điền đủ một tờ khai nhập khẩu cho bộ tài liệu này.',
  };
  if (type === 'unknown') return {
    title: 'Cần xác định lô hàng và chiều vận chuyển',
    description: 'Chưa đủ căn cứ xác định nhập khẩu hay xuất khẩu, hoặc bộ tài liệu chứa nhiều chuyến. Kiểm tra chứng từ, tách đúng lô hàng và chọn loại hồ sơ trước khi điền bản khai.',
  };
  return {
    title: 'Loại hồ sơ chưa hỗ trợ',
    description: 'Biểu mẫu hiện tại dành cho nhập khẩu. Kiểm tra loại hồ sơ thực tế; chứng từ vẫn được lưu để tra cứu.',
  };
}
