import { describe, it, expect, vi } from 'vitest';
import { getOnTimeStats, getMethodStats } from '../shipmentStatsService';

function data(orders: any[], tickets: any[], links: any[] = []) {
  const client: any = {
    order: { findMany: vi.fn(async () => orders) },
    shipmentOrderAllocation: { findMany: vi.fn(async () => links) },
    shipment: { findMany: vi.fn(async ({ where }: any) => {
      if (where?.ata?.not === null) return tickets.filter(s => s.ata !== null && s.eta !== null && ['Shipped','Arrived','Cleared','Delivered'].includes(s.status));
      if (where?.status?.not === 'Cancelled') return tickets.filter(s => s.status !== 'Cancelled');
      return tickets;
    }) },
  };
  return client;
}
const ticket = (id: string, orderId: string | null, ata: string | null, status = 'Shipped') => ({ id, orderId, ata, eta: '2026-10-15', etd: '2026-10-01', status, shippingMethod: 'Sea' });

describe('actual shipment statistics completion contract', () => {
  it('SSC01 first arrival cannot close an order whose later active ticket has unknown ATA', async () => {
    const stats = await getOnTimeStats(data([{id:'O1',dueDate:'2026-10-15'}], [ticket('S1','O1','2026-10-10'),ticket('S2','O1',null)]));
    expect(stats.order).toEqual({total:1,onTime:0,late:0,pending:1,rate:null});
  });
  it('SSC02 non-primary SOA order uses every actual ticket and remains pending until all arrive', async () => {
    const prisma = data([{id:'O2',dueDate:'2026-10-15'}], [ticket('S1','O1','2026-10-10'),ticket('S2','O1',null)], [{id:'A1',shipmentId:'S1',orderId:'O2',status:'Fulfilled'},{id:'A2',shipmentId:'S2',orderId:'O2',status:'Fulfilled'}]);
    expect((await getOnTimeStats(prisma)).order.pending).toBe(1);
    const rows = await prisma.shipment.findMany({where:{}}); rows[1].ata='2026-10-16';
    expect((await getOnTimeStats(prisma)).order).toEqual({total:1,onTime:0,late:1,pending:0,rate:0});
  });
  it('SSC03 cancelled ticket does not block a completed order and duplicate SOA rows do not duplicate tickets', async () => {
    const p=data([{id:'O1',dueDate:'2026-10-15'}], [ticket('S1','O1','2026-10-15'),ticket('S2','O1',null,'Cancelled')], [{id:'A1',shipmentId:'S1',orderId:'O1',status:'Fulfilled'},{id:'A2',shipmentId:'S1',orderId:'O1',status:'Fulfilled'}]);
    expect((await getOnTimeStats(p)).order).toEqual({total:1,onTime:1,late:0,pending:0,rate:1});
  });
  it('SSC04 invalid ATA or dueDate stays pending, not a fabricated on-time observation', async () => {
    const p=data([{id:'O1',dueDate:'2026-10-15'},{id:'O2',dueDate:'2026-02-30'}], [ticket('S1','O1','2026-02-30'),ticket('S2','O2','2026-01-01')]);
    expect((await getOnTimeStats(p)).order).toEqual({total:2,onTime:0,late:0,pending:2,rate:null});
  });
  it('SSC05 absent complete SOA storage is a failure, never the legacy direct-parent fallback', async () => {
    const p=data([{id:'O1',dueDate:'2026-10-15'}], [ticket('S1','O1','2026-10-10')]); delete p.shipmentOrderAllocation;
    await expect(getOnTimeStats(p)).rejects.toBeDefined();
  });
  it('SSC06 method counting, normalization, interval and rounded rate remain unchanged for valid dates', async () => {
    const a={...ticket('S1','O1','2026-10-10'),shippingMethod:'Sea Freight'};
    const b={...ticket('S2','O1','2026-10-16'),status:'Delivered'};
    const c={...ticket('S3',null,null,'Cancelled'),etd:'2026-09-01'};
    expect(await getMethodStats(data([], [a,b,c]), {from:'2026-10-01',to:'2026-10-31'})).toEqual({from:'2026-10-01',to:'2026-10-31',methods:[{method:'Sea',total:2,inTransit:1,delivered:1,cancelled:0,judged:2,onTime:1,late:1,onTimeRate:0.5}]});
  });
});
