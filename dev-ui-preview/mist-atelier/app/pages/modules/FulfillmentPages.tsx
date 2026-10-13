/** 订单履约模块入口：每个页面在各自文件中实现，这里只登记视图映射。 */
import type React from 'react';
import { SamplesPage } from './SamplesPage';
import { QcWorkbenchPage } from './QcWorkbenchPage';
import { ProcurementPage } from './ProcurementPage';
import { InventoryPage } from './InventoryPage';
import { ShipmentsPage } from './ShipmentsPage';
import { CustomsPage } from './CustomsPage';
import { DocumentCenterPage } from './DocumentCenterPage';
import { MesHistoryPage } from './MesHistoryPage';
export { SamplesPage, QcWorkbenchPage, ProcurementPage, InventoryPage, ShipmentsPage, CustomsPage, DocumentCenterPage, MesHistoryPage };

export const FULFILLMENT_PAGES: Record<string, React.FC> = { 'samples': SamplesPage, 'qc-workbench': QcWorkbenchPage, 'shipments': ShipmentsPage, 'procurement': ProcurementPage, 'inventory': InventoryPage, 'customs': CustomsPage, 'document-center': DocumentCenterPage, 'mes': MesHistoryPage };
