
import logging
import time

from openerp import tools
from openerp.osv import fields, osv
from openerp.tools.translate import _

import openerp.addons.decimal_precision as dp
import openerp.addons.product.product

_logger = logging.getLogger(__name__)

# class account_bank_statement(osv.osv):
#     _inherit = "account.bank.statement"
#     
#     def _check_selected(self, cr, uid, ids, context=None):
#         cr.execute('''
#             select count(*) from account_bank_statement where use_pos = true
#         ''')
#         answer = cr.fetchone()[0]
#         if answer > 1:
#             return False 
#         return True
# 
#     _constraints = [
#         (_check_selected, 'Cannot have more than cash register used fro POS', ['use_pos']),
#     ]
#     
#     _columns = {
#                 'use_pos':fields.boolean("Use this cash register for the POS")
#                 }

class pos_order(osv.osv):
    _inherit = "pos.order"


    def create_modify_order(self,cr,uid,list_record,context=None):
        line_obj = self.pool.get('pos.order.line')
        order_id = False
        for line in list_record:
            brw = line_obj.browse(cr,uid,line.get('id',False),context)
            if (brw.available_qty > line.get('available_qty',0)):
                if not order_id:
                    order_id = self.create(cr,uid,{
                                    'name':"Back Order"
                                    },context)     
                line_obj.create(cr,uid,{
                                        'product_id':line.get('product_id',False),
                                        'qty': line.get('available_qty',0) - brw.available_qty,
                                        'price_unit': line.get('price',False),
                                        'order_id':order_id
                                        },context)
                line_obj.write(cr,uid,line.get('id',False),{'return_qty':brw.return_qty+brw.available_qty - line.get('available_qty',0)},context)

        if order_id:
            self.payment_recieved(cr,uid,{'order_ids':[order_id]},context)
        return True
    
    def _get_order(self, cr, uid, ids, context=None):
        result = {}
        for line in self.pool.get('pos.order.line').browse(cr, uid, ids, context=context):
            result[line.order_id.id] = True
        return result.keys()
    
    def _amount_all(self, cr, uid, ids, name, args, context=None):
        cur_obj = self.pool.get('res.currency')
        res = {}
        for order in self.browse(cr, uid, ids, context=context):
            res[order.id] = {
                'amount_paid': 0.0,
                'amount_return':0.0,
                'amount_tax':0.0,
            }
            val1 = val2 = 0.0
            cur = order.pricelist_id.currency_id
            for payment in order.statement_ids:
                res[order.id]['amount_paid'] +=  payment.amount
                res[order.id]['amount_return'] += (payment.amount < 0 and payment.amount or 0)
            for line in order.lines:
                val1 += line.price_subtotal_incl
                val2 += line.price_subtotal
            res[order.id]['amount_tax'] = cur_obj.round(cr, uid, cur, val1-val2)
            res[order.id]['amount_total'] = cur_obj.round(cr, uid, cur, val1)
        return res
    
    
    _columns = {
        'sequence_partner':fields.related('partner_id','sequence',type="char"),
        'parent_id': fields.many2one('pos.order', 'Parent Order'),
        'amount_total': fields.function(_amount_all, string='Total', digits_compute=dp.get_precision('Account'),  multi='all',
                                         store={
                'pos.order': (lambda self, cr, uid, ids, c={}: ids, ['lines'], 10),
                'pos.order.line': (_get_order, ['qty', 'return_qty', 'price_unit', 'discount'], 10),
            }),
    }
    
    
    def refund(self, cr, uid, ids, context=None):
        """Create a copy of order  for refund order"""
        clone_list = []
        line_obj = self.pool.get('pos.order.line')
        
        for order in self.browse(cr, uid, ids, context=context):
            current_session_ids = self.pool.get('pos.session').search(cr, uid, [
                ('state', '!=', 'closed'),
                ('user_id', '=', uid)], context=context)
            if not current_session_ids:
                raise osv.except_osv(_('Error!'), _('To return product(s), you need to open a session that will be used to register the refund.'))

            clone_id = self.copy(cr, uid, order.id, {
                'name': order.name + ' REFUND', # not used, name forced by create
                'session_id': current_session_ids[0],
                'date_order': time.strftime('%Y-%m-%d %H:%M:%S'),
                'parent_id': order.id,
            }, context=context)
            clone_list.append(clone_id)

        for clone in self.browse(cr, uid, clone_list, context=context):
            for order_line in clone.lines:
                print order_line.available_qty
                line_obj.write(cr, uid, [order_line.id], {
                    'return_qty': 0.0,
                    'qty': -(order_line.parent_id.available_qty),
                }, context=context)

        abs = {
            'name': _('Return Products'),
            'view_type': 'form',
            'view_mode': 'form',
            'res_model': 'pos.order',
            'res_id':clone_list[0],
            'view_id': False,
            'context':context,
            'type': 'ir.actions.act_window',
            'nodestroy': True,
            'target': 'current',
        }
        return abs

   
    def payment_recieved(self,cr,uid,journal_id,order_ids,context=None):
        # get the cash journal_id
        if context == None:context = {}
        wizard = self.pool.get('pos.make.payment')
        pos_order = self.pool.get('pos.order')
        for order_id in order_ids.get('order_ids',False):
            amount  = pos_order.browse(cr,uid,int(order_id),context)
            cr.execute('''
            update pos_order set session_id = %s where id  = %s
            ''' %(context.get('session_id',False) or order_ids.get('session_id',False),amount.id))
            if journal_id:
                id = wizard.create(cr,uid,{'journal_id':journal_id,'amount':amount.amount_total},context)
                wizard.check(cr,uid,[id],context={'active_id':amount.id})
                
    def pay_order(self, cr, uid, order_id, context=None):
        try:
                self.signal_workflow(cr, uid, [order_id], 'paid')
        except Exception as e:
            _logger.error('Could not fully process the POS Order: %s', tools.ustr(e))

        #self.action_invoice(cr, uid, [order_id], context)
        #order_obj = self.browse(cr, uid, order_id, context)
        #self.pool['account.invoice'].signal_workflow(cr, uid, [order_obj.invoice_id.id], 'invoice_open')

    def create_from_ui(self, cr, uid, orders, context=None):
        # Keep only new orders
        submitted_references = [o['data']['name'] for o in orders]
        existing_order_ids = self.search(cr, uid, [('pos_reference', 'in', submitted_references)], context=context)
        existing_orders = self.read(cr, uid, existing_order_ids, ['pos_reference'], context=context)
        existing_references = set([o['pos_reference'] for o in existing_orders])
        orders_to_save = [o for o in orders if o['data']['name'] not in existing_references]

        order_ids = []

        for tmp_order in orders_to_save:
            to_invoice = tmp_order['to_invoice']
            order = tmp_order['data']
            order_id = self.create(cr, uid, self._order_fields(cr, uid, order, context=context),context)
            if order.get('partner_id'):
                self.write(cr, uid, order_id, {'session_id': False}, context=context)

            for payments in order['statement_ids']:
                self.add_payment(cr, uid, order_id, self._payment_fields(cr, uid, payments[2], context=context), context=context)

            session = self.pool.get('pos.session').browse(cr, uid, order['pos_session_id'], context=context)
            if session.sequence_number <= order['sequence_number']:
                session.write({'sequence_number': order['sequence_number'] + 1})
                session.refresh()

            if order['amount_return'] and not order['partner_id']:
                cash_journal = session.cash_journal_id
                if not cash_journal:
                    cash_journal_ids = filter(lambda st: st.journal_id.type=='cash', session.statement_ids)
                    if not len(cash_journal_ids):
                        raise osv.except_osv( _('error!'),
                            _("No cash statement found for this session. Unable to record returned cash."))
                    cash_journal = cash_journal_ids[0].journal_id
                self.add_payment(cr, uid, order_id, {
                    'amount': -order['amount_return'],
                    'payment_date': time.strftime('%Y-%m-%d %H:%M:%S'),
                    'payment_name': _('return'),
                    'journal': cash_journal.id,
                }, context=context)
            order_ids.append(order_id)
            if orders[0]['data'].get('partner_id'):
                return order_ids
            try:
                self.signal_workflow(cr, uid, [order_id], 'paid')
            except Exception as e:
                _logger.error('Could not fully process the POS Order: %s', tools.ustr(e))

            if to_invoice:
                self.action_invoice(cr, uid, [order_id], context)
                order_obj = self.browse(cr, uid, order_id, context)
                self.pool['account.invoice'].signal_workflow(cr, uid, [order_obj.invoice_id.id], 'invoice_open')

        return order_ids
    
        
class pos_order_line(osv.osv):
    _name = 'pos.order.line'
    _inherit = 'pos.order.line'

    def create(self, cr, uid, values, context=None):
        if context == None:context = {}
        if context.get('__copy_data_seen'):
            data = context.get('__copy_data_seen')
            line_id = data.get('pos.order.line', False)
            if line_id:
                line_obj = self.browse(cr, uid, line_id[0], context=context)
                #self.write(cr, uid, [line_obj.parent_id.id],{'return_qty': line_obj.parent_id.return_qty +  line_obj.qty}, context=context)
                values.update({'parent_id':line_id[0], 'qty': -(line_obj.parent_id.available_qty)} )
                print "CREATED ... ", values.update({'qty': line_obj.parent_id.available_qty })
                res = super(pos_order_line, self).create(cr, uid, values, context=context)
                line_obj.refresh()
                return res
        else:
            res = super(pos_order_line, self).create(cr, uid, values, context=context)
        return res

    def write(self, cr, uid, ids, vals, context=None):
        if vals.get('qty'):
            cur = self.browse(cr, uid, ids[0], context=None)
            if cur.parent_id:
                total = 0.0
                check = (cur.parent_id.qty - cur.parent_id.return_qty) + abs(cur.qty)
                print check
                print "DONT", vals.get('qty')
                if check >= abs(vals.get('qty')):
                    res = self.write(cr, uid, [cur.parent_id.id],
                        {'return_qty': ( cur.parent_id.return_qty - abs(cur.qty)) + 
                        abs(vals.get('qty'))}, context=context)
                    res = super(pos_order_line, self).write(cr, uid, ids, vals, context=context)
                else:
                    raise osv.except_osv( _('Error!'), _("You cannot return product more then order quantity."))
            else:
                res = super(pos_order_line, self).write(cr, uid, ids, vals, context=context)
        else:
            res = super(pos_order_line, self).write(cr, uid, ids, vals, context=context)
        return res

    def _check_available(self, cr, uid, ids, field_names, arg, context=None):
        res = {}
        for line in self.browse(cr, uid, ids, context=context):
            res[line.id] = line.qty - line.return_qty
        return res

    def _amount_line_all(self, cr, uid, ids, field_names, arg, context=None):
        res = dict([(i, {}) for i in ids])
        account_tax_obj = self.pool.get('account.tax')
        cur_obj = self.pool.get('res.currency')
        for line in self.browse(cr, uid, ids, context=context):
            taxes_ids = [ tax for tax in line.product_id.taxes_id if tax.company_id.id == line.order_id.company_id.id ]
            price = line.price_unit * (1 - (line.discount or 0.0) / 100.0)
            taxes = account_tax_obj.compute_all(cr, uid, taxes_ids, price, (line.qty - line.return_qty), product=line.product_id, partner=line.order_id.partner_id or False)
            cur = line.order_id.pricelist_id.currency_id
            res[line.id]['price_subtotal'] = cur_obj.round(cr, uid, cur, taxes['total'])
            res[line.id]['price_subtotal_incl'] = cur_obj.round(cr, uid, cur, taxes['total_included'])
        return res


    _columns = {
        'return_qty': fields.float('Return Quantity', digits_compute=dp.get_precision('Product UoS')),
        'parent_id': fields.many2one('pos.order.line', 'Parent Line'),
        'available_qty': fields.function(_check_available,  type='float', string='Available Quantity', store=True),
        'price_subtotal': fields.function(_amount_line_all, multi='pos_order_line_amount', digits_compute=dp.get_precision('Account'), string='Subtotal w/o Tax', store=True),
        'price_subtotal_incl': fields.function(_amount_line_all, multi='pos_order_line_amount', digits_compute=dp.get_precision('Account'), string='Subtotal', store=True),

    }
