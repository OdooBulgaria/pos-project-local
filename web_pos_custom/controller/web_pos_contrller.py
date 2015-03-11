import openerp
from openerp.addons.web.controllers.main import module_boot, login_redirect, Home, ensure_db
from openerp import http
from openerp.http import request
from openerp.osv import osv

class POS_Custom(http.Controller):
    @http.route('/poscustom/close', type='json', auth="user")
    def session_close(self):
        cr, uid, context = request.cr, request.uid, request.context
        is_manager = is_user = None
        pos_session = request.registry('pos.session')
        ids= pos_session.search(cr, uid, [('state','<>','closed'), ('user_id','=',uid)], context=context)
        id = ids and ids[0] or False
        is_manager = request.registry('ir.model.access').check_groups(cr, uid, "point_of_sale.group_pos_manager")
        result = {'result': True,'is_manager': is_manager, 'is_user':is_user}
        if not is_manager:
            is_user = request.registry('ir.model.access').check_groups(cr, uid, "point_of_sale.group_pos_user")
            result["is_user"] = is_user
        
        if id and is_user:
            pos_browse = pos_session.browse(cr, uid, id, context=context)
            pos_browse.signal_workflow('cashbox_control')
            pos_browse.signal_workflow('close')
            return result
        if id and is_manager:
            return result
        result['result'] = False
        return result

class New_Home(Home):
    @http.route('/web/login', type='http', auth="none")
    def web_login(self, redirect=None, **kw):
        ensure_db()
        if request.httprequest.method == 'GET' and redirect and request.session.uid:
            return http.redirect_with_hash(redirect)

        if not request.uid:
            request.uid = openerp.SUPERUSER_ID

        values = request.params.copy()
        if not redirect:
            redirect = '/web?' + request.httprequest.query_string
        values['redirect'] = redirect

        try:
            values['databases'] = http.db_list()
        except openerp.exceptions.AccessDenied:
            values['databases'] = None

        if request.httprequest.method == 'POST':
            old_uid = request.uid
            uid = request.session.authenticate(request.session.db, request.params['login'], request.params['password'])
            cr, context = request.cr, request.context
            pos_session = request.registry('pos.session')
            def check_contraints(config_id):
                check, value = False,None
                domain = [
                          ('state', '!=', 'closed'),
                          ('config_id', '=', config_id)
                ]
                if pos_session.search_count(cr, uid, domain, context=context)>0:
                    check, value = True, "You cannot create two active sessions related to the same point of sale. Contact Administrator!"
                domain = [
                    ('state', 'not in', ('closed','closing_control')),
                    ('user_id', '=', uid)
                ]
                if pos_session.search_count(cr, uid, domain, context=context)>0:
                    check, value = True, "You cannot create two active sessions with the same responsible. Contact Administrator!"
                return check, value
            
            if uid is not False:
                user = request.registry['res.users'].browse(cr, uid, uid, context)
                is_manager = request.registry('ir.model.access').check_groups(cr, uid, "point_of_sale.group_pos_manager")
                if not is_manager:
                    is_user = request.registry('ir.model.access').check_groups(cr, uid, "point_of_sale.group_pos_user")
                    if is_user:
                        current_user = request.registry('res.users').browse(cr, uid, uid, context= context)
                        pos_config_id = current_user.pos_config and current_user.pos_config.id or False
                        if not pos_config_id:
                            r = request.registry('pos.config').search(cr, uid, [], context=context)
                            pos_config_id = r and r[0] or False
                        check, error = check_contraints(pos_config_id)
                        if check:
                            values['error'] = error
                            return request.render('web.login', values)
                        session_id = pos_session.create(cr, uid, {'user_id' : uid,'config_id' : pos_config_id}, context=context)
                        if pos_session.browse(cr, uid, session_id, context=context).state == 'opened':
                            redirect = redirect.replace("/web","/pos/web")
                else:
                    #To do code for manager
                    pass
                return http.redirect_with_hash(redirect)
            request.uid = old_uid
            values['error'] = "Wrong login/password"
        return request.render('web.login', values)
