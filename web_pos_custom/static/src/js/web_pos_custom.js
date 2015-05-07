openerp.web_pos_custom = function(instance) {
    var _t = instance.web._t;
    var QWeb = instance.web.qweb;
    var module = instance.point_of_sale;
    var round_di = instance.web.round_decimals;
    var round_pr = instance.web.round_precision;
    var cash_register = {};

module.PosDB =  module.PosDB.extend({
    _partner_search_string: function(partner){
        var str =  partner.name;
        if (partner.sequence){
        	str+= '|'+partner.sequence;
        }
        if(partner.ean13){
            str += '|' + partner.ean13;
        }
        if(partner.address){
            str += '|' + partner.address;
        }
        if(partner.phone){
            str += '|' + partner.phone.split(' ').join('');
        }
        if(partner.mobile){
            str += '|' + partner.mobile.split(' ').join('');
        }
        if(partner.email){
            str += '|' + partner.email;
        }
        str = '' + partner.id + ':' + str.replace(':','') + '\n';
        return str;
    },	
});  
    
module.PosModel = module.PosModel.extend({
    models: [
             {
                 model:  'res.users',
                 fields: ['name','company_id'],
                 ids:    function(self){ return [self.session.uid]; },
                 loaded: function(self,users){ self.user = users[0]; },
             },{ 
                 model:  'res.company',
                 fields: [ 'currency_id', 'email', 'website', 'company_registry', 'vat', 'name', 'phone', 'partner_id' , 'country_id'],
                 ids:    function(self){ return [self.user.company_id[0]] },
                 loaded: function(self,companies){ self.company = companies[0]; },
             },{
                 model:  'decimal.precision',
                 fields: ['name','digits'],
                 loaded: function(self,dps){
                     self.dp  = {};
                     for (var i = 0; i < dps.length; i++) {
                         self.dp[dps[i].name] = dps[i].digits;
                     }
                 },
             },{ 
                 model:  'product.uom',
                 fields: [],
                 domain: null,
                 loaded: function(self,units){
                     self.units = units;
                     var units_by_id = {};
                     for(var i = 0, len = units.length; i < len; i++){
                         units_by_id[units[i].id] = units[i];
                         units[i].groupable = ( units[i].category_id[0] === 1 );
                         units[i].is_unit   = ( units[i].id === 1 );
                     }
                     self.units_by_id = units_by_id;
                 }
             },{
                 model:  'res.users',
                 fields: ['name','ean13'],
                 domain: null,
                 loaded: function(self,users){
                	 self.users = users; 
            	 },
             },{
                 model:  'res.partner',
                 fields: ['name','street','street2','sequence','city','state_id','country_id','vat','phone','zip','mobile','email','ean13','write_date'],
                 domain: [['customer','=',true]],
                 loaded: function(self,partners){
                     self.partners = partners;
                     self.db.add_partners(partners);
                 },
             },{
                 model:  'res.country',
                 fields: ['name'],
                 loaded: function(self,countries){
                     self.countries = countries;
                     self.company.country = null;
                     for (var i = 0; i < countries.length; i++) {
                         if (countries[i].id === self.company.country_id[0]){
                             self.company.country = countries[i];
                         }
                     }
                 },
             },{
                 model:  'account.tax',
                 fields: ['name','amount', 'price_include', 'include_base_amount', 'type'],
                 domain: null,
                 loaded: function(self,taxes){ 
                     self.taxes = taxes; 
                     self.taxes_by_id = {};
                     for (var i = 0; i < taxes.length; i++) {
                         self.taxes_by_id[taxes[i].id] = taxes[i];
                     }
                 },
             },{
                 model:  'pos.session',
                 fields: ['id', 'journal_ids','name','user_id','config_id','start_at','stop_at','sequence_number','login_number'],
                 domain: function(self){ return [['state','=','opened'],['user_id','=',self.session.uid]]; },
                 loaded: function(self,pos_sessions){
                     self.pos_session = pos_sessions[0]; 

                     var orders = self.db.get_orders();
                     for (var i = 0; i < orders.length; i++) {
                         self.pos_session.sequence_number = Math.max(self.pos_session.sequence_number, orders[i].data.sequence_number+1);
                     }
                 },
             },{
                 model: 'pos.config',
                 fields: [],
                 domain: function(self){ return [['id','=', self.pos_session.config_id[0]]]; },
                 loaded: function(self,configs){
                     self.config = configs[0];
                     self.config.use_proxy = self.config.iface_payment_terminal || 
                                             self.config.iface_electronic_scale ||
                                             self.config.iface_print_via_proxy  ||
                                             self.config.iface_scan_via_proxy   ||
                                             self.config.iface_cashdrawer;
                     
                     self.barcode_reader.add_barcode_patterns({
                         'product':  self.config.barcode_product,
                         'cashier':  self.config.barcode_cashier,
                         'client':   self.config.barcode_customer,
                         'weight':   self.config.barcode_weight,
                         'discount': self.config.barcode_discount,
                         'price':    self.config.barcode_price,
                     });

                     if (self.config.company_id[0] !== self.user.company_id[0]) {
                         throw new Error(_t("Error: The Point of Sale User must belong to the same company as the Point of Sale. You are probably trying to load the point of sale as an administrator in a multi-company setup, with the administrator account set to the wrong company."));
                     }
                 },
             },{
                 model: 'stock.location',
                 fields: [],
                 ids:    function(self){ return [self.config.stock_location_id[0]]; },
                 loaded: function(self, locations){ self.shop = locations[0]; },
             },{
                 model:  'product.pricelist',
                 fields: ['currency_id'],
                 ids:    function(self){ return [self.config.pricelist_id[0]]; },
                 loaded: function(self, pricelists){ self.pricelist = pricelists[0]; },
             },{
                 model: 'res.currency',
                 fields: ['symbol','position','rounding','accuracy'],
                 ids:    function(self){ return [self.pricelist.currency_id[0]]; },
                 loaded: function(self, currencies){
                     self.currency = currencies[0];
                     if (self.currency.rounding > 0) {
                         self.currency.decimals = Math.ceil(Math.log(1.0 / self.currency.rounding) / Math.log(10));
                     } else {
                         self.currency.decimals = 0;
                     }

                 },
             },{
                 model: 'product.packaging',
                 fields: ['ean','product_tmpl_id'],
                 domain: null,
                 loaded: function(self, packagings){ 
                     self.db.add_packagings(packagings);
                 },
             },{
                 model:  'pos.category',
                 fields: ['id','name','parent_id','child_id','image'],
                 domain: null,
                 loaded: function(self, categories){
                     self.db.add_categories(categories);
                 },
             },{
                 model:  'product.product',
                 fields: ['display_name', 'list_price','price','pos_categ_id', 'taxes_id', 'ean13', 'default_code', 
                          'to_weight', 'uom_id', 'uos_id', 'uos_coeff', 'mes_type', 'description_sale', 'description',
                          'product_tmpl_id'],
                 domain: [['sale_ok','=',true],['available_in_pos','=',true]],
                 context: function(self){ return { pricelist: self.pricelist.id, display_default_code: false }; },
                 loaded: function(self, products){
                     self.db.add_products(products);
                 },
             },{
                 model:  'account.bank.statement',
                 fields: ['account_id','currency','journal_id','state','name','user_id','pos_session_id'],
                 domain: function(self){ return [['state', '=', 'open'],['pos_session_id', '=', self.pos_session.id]]; },
                 loaded: function(self, bankstatements, tmp){
                     self.bankstatements = bankstatements;

                     tmp.journals = [];
                     _.each(bankstatements,function(statement){
                         tmp.journals.push(statement.journal_id[0]);
                     });
                 },
             },{
                 model:  'account.journal',
                 fields: [],
                 domain: function(self,tmp){ return [['id','in',tmp.journals]]; },
                 loaded: function(self, journals){
                     self.journals = journals;

                     // associate the bank statements with their journals. 
                     var bankstatements = self.bankstatements;
                     for(var i = 0, ilen = bankstatements.length; i < ilen; i++){
                         for(var j = 0, jlen = journals.length; j < jlen; j++){
                             if(bankstatements[i].journal_id[0] === journals[j].id){
                                 bankstatements[i].journal = journals[j];
                             }
                         }
                     }
                     self.cashregisters = bankstatements;
                 },
             },{
                 label: 'fonts',
                 loaded: function(self){
                     var fonts_loaded = new $.Deferred();

                     // Waiting for fonts to be loaded to prevent receipt printing
                     // from printing empty receipt while loading Inconsolata
                     // ( The font used for the receipt ) 
                     waitForWebfonts(['Lato','Inconsolata'], function(){
                         fonts_loaded.resolve();
                     });

                     // The JS used to detect font loading is not 100% robust, so
                     // do not wait more than 5sec
                     setTimeout(function(){
                         fonts_loaded.resolve();
                     },5000);

                     return fonts_loaded;
                 },
             },{
                 label: 'pictures',
                 loaded: function(self){
                     self.company_logo = new Image();
                     var  logo_loaded = new $.Deferred();
                     self.company_logo.onload = function(){
                         var img = self.company_logo;
                         var ratio = 1;
                         var targetwidth = 300;
                         var maxheight = 150;
                         if( img.width !== targetwidth ){
                             ratio = targetwidth / img.width;
                         }
                         if( img.height * ratio > maxheight ){
                             ratio = maxheight / img.height;
                         }
                         var width  = Math.floor(img.width * ratio);
                         var height = Math.floor(img.height * ratio);
                         var c = document.createElement('canvas');
                             c.width  = width;
                             c.height = height
                         var ctx = c.getContext('2d');
                             ctx.drawImage(self.company_logo,0,0, width, height);

                         self.company_logo_base64 = c.toDataURL();
                         logo_loaded.resolve();
                     };
                     self.company_logo.onerror = function(){
                         logo_loaded.reject();
                     };
                         self.company_logo.crossOrigin = "anonymous";
                     self.company_logo.src = '/web/binary/company_logo' +'?_'+Math.random();

                     return logo_loaded;
                 },
             },
             ],
});
    
module.SynchNotificationWidget = module.SynchNotificationWidget.extend({
    start: function(){
        var self = this;
        this.pos.bind('change:synch', function(pos,synch){
            self.set_status(synch.state, synch.pending);
        });
        this.$el.click(function(){
            self.pos.push_order();
            self.pos.modify_order();
            self.pos.pay_orders();
        });
    },
});

module.Order = module.Order.extend({

    addProduct: function(product, options){
    	options = options || {};
        var attr = JSON.parse(JSON.stringify(product));
        attr.pos = this.pos;
        attr.order = this;
        var line = new module.Orderline({}, {pos: this.pos, order: this, product: product});
        
        if (options.available_qty !== undefined){
        	line.available_qty = options.available_qty;
        }
        if (options.pos_id !== undefined){
        	line.pos_id = options.pos_id;
        }
        if(options.quantity !== undefined){
            line.set_quantity(options.quantity);
        }
        if(options.price !== undefined){
            line.set_unit_price(options.price);
        }
        if(options.discount !== undefined){
            line.set_discount(options.discount);
        }

        var last_orderline = this.getLastOrderline();
        if( last_orderline && last_orderline.can_be_merged_with(line) && options.merge !== false){
            last_orderline.merge(line);
        }else{
        	this.get('orderLines').add(line);
        }
        this.selectLine(this.getLastOrderline());
    },
    removeOrderline: function( line ){
        this.get('orderLines').remove(line);
        this.selectLine(this.getLastOrderline());
    },
    getOrderline: function(id){
        var orderlines = this.get('orderLines').models;
        for(var i = 0; i < orderlines.length; i++){
            if(orderlines[i].id === id){
                return orderlines[i];
            }
        }
        return null;
    },	
	
});

module.OrderWidget = module.OrderWidget.extend({
    set_value: function(val) {
    	var self = this;
    	var order = this.pos.get('selectedOrder');
    	if (this.editable && order.getSelectedLine()) {
            var mode = this.numpad_state.get('mode');
            if( mode === 'quantity'){
                if (this.pos_widget.available_qty){
                	if  (parseFloat(val) > self.pos_widget.available_qty_lines[order.getSelectedLine().pos_id]){
                		self.numpad_state.set({
                			'buffer':'0',
                		});
                		self.pos_widget.screen_selector.show_popup('error',{
                            'message':_t('Error: Could not Modify'),
                            'comment':_t('The modified qty cannot be greater than original'),
                        });                		
                		return; 
                	}
                	order.getSelectedLine().set_availbale_qty(val)
                }else{
                	order.getSelectedLine().set_quantity(val);
                }
            }else if( mode === 'discount'){
                order.getSelectedLine().set_discount(val);
            }else if( mode === 'price'){
                order.getSelectedLine().set_unit_price(val);
            }
    	}
    },

    update_summary: function(){
    	var order = this.pos.get('selectedOrder');
        var total     = order ? order.getTotalTaxIncluded() : 0;
        var taxes     = order ? total - order.getTotalTaxExcluded() : 0;    		
        this.el.querySelector('.summary .total > .value').textContent = this.format_currency(total);
        this.el.querySelector('.summary .total .subentry .value').textContent = this.format_currency(taxes);
    },        
    
});	

//Button Extend
var orderline_id = 1;
module.Orderline = module.Orderline.extend({
    initialize: function(attr,options){
        this.pos = options.pos;
        this.order = options.order;
        this.product = options.product;
        this.price   = options.product.price;
        this.quantity = 1;
        this.quantityStr = '1';
        this.discount = 0;
        this.discountStr = '0';
        this.type = 'unit';
        this.selected = false;
        this.id       = orderline_id++;
        this.pos_id = 0;
        this.available_qty = undefined;
    },
    get_base_price:    function(){
    	var rounding = this.pos.currency.rounding;
    	if (this.available_qty !== undefined){
    		return round_pr(this.price * this.available_qty * (1 - this.get_discount()/100), rounding);
    	}else{
    		return round_pr(this.get_unit_price() * this.get_quantity() * (1 - this.get_discount()/100), rounding);
    	}
    	
    },    
    get_available_qty:function(){
    	return this.available_qty;
    },
    
    get_subtotal_modify:function(){
        var rounding = this.pos.currency.rounding;
        return round_pr(this.price * this.available_qty * (1 - this.get_discount()/100), rounding);
    },
    
    set_availbale_qty:function(quantity){
    	if (!quantity || quantity == 'remove'){
    		this.available_qty = 0;
    	}else{
        	var quant = parseFloat(quantity) || 0;
            var unit = this.get_unit();
            if(unit){
                if (unit.rounding) {
                	this.available_qty=round_pr(quant, unit.rounding);
                } else {
                    this.available_qty= round_pr(quant, 1);
                }
            }else{
                this.available_qty = quant;
            }    		
    	}
        this.trigger('change',this);      
    },
})
    
    instance.point_of_sale.PaypadWidget = instance.point_of_sale.PosBaseWidget.extend({
        template: 'PaypadWidget',
        init: function(parent, options){
            this._super(parent);
            this.options = options;
        },
        renderElement: function() {
            var self = this;
            this._super();
            if(self.options.screen == "products" || self.options.screen == "orders" ){
				_.each(self.options.buttons, function(button, index) {
	            	var button = new module.PaypadButtonWidget(self,{
	                    pos: self.pos,
	                    pos_widget : self.pos_widget,
	                    cashregister: self.pos.cashregisters[0],
	                    pos_name: button,
	                    template: self.options.template
	                });
	                button.appendTo(self.$el);
	            });
            }else{
                _.each(self.options.buttons, function(button, index) {
                    var button = new module.PaypadButtonWidget(self,{
                        pos: self.pos,
                        pos_widget : self.pos_widget,
                        pos_name: button,
                        template: self.options.template
                    });
                    button.appendTo(self.$el);
                }); //			            	
            }

            return;
        }
    });

    instance.point_of_sale.PaypadButtonWidget = instance.point_of_sale.PosBaseWidget.extend({
        template: 'PaypadButtonWidget',
        init: function(parent, options){
            this._super(parent, options);
            this.cashregister = options.cashregister;
            this.template = options.template;
            this.pos_name = options.pos_name;
        },
        
        modify_order:function(order_id,check_save){ 
        	var self = this;
        	var list_record = []
        	var model = new instance.web.Model('pos.order.line');
        	var model_order =  new instance.web.Model('pos.order');
        	var currentOrder = self.pos.get('selectedOrder');
        	var amount_total = currentOrder.getTotalTaxIncluded();
        	
        	if (check_save){
        		_.each(self.pos.db.cache.orders,function(order){
        			if (order_id == order.id){
        				line_record = [];
        				self.pos_widget.offline_pos_orders.orders[order_id].lines = [];
        				while(true){
        	                var order_line = self.pos.get('selectedOrder').get('orderLines').at(0);
        	                if (order_line){
        	     	    		line_record.push([0,0,{
        	     	    			'discount':order_line.discount ,
        	     	    			'price_unit':order_line.price,
        	     	    			'product_id':order_line.product.id,
        	     	    			'qty':order_line.available_qty,
        	     	    		}]);
        	     	    		self.pos_widget.offline_pos_orders.orders[order_id].lines.push({
        	     	    			'available_qty':order_line.available_qty,
        	     	    			'discount':order_line.discount,
        	     	    			'id':0,
        	     	    			'price_unit':order_line.price,
        	     	    			'qty':order_line.available_qty,
        	     	    			'return_qty':0,
        	     	    			'product':self.pos.db.product_by_id[order_line.product.id],
        	     	    		});
        	     	    	}else{break;}
        	 	    		order_line.set_quantity("remove");
    	        		}
        				self.pos.db.cache.orders[self.pos.db.cache.orders.indexOf(order)].data.lines = line_record;
        				//finding the -ve statements
        				negative_statement = 0.00;
        				_.each(self.pos.db.cache.orders[self.pos.db.cache.orders.indexOf(order)].data.statement_ids,function(statements){
        					if (statements[2].amount < 0){
        						negative_statement + = statements[2].amount;
        					}
        				});
        				amount_for_statement = order.data.amount_paid - order.data.amount_return + negative_statement - amount_total;
        				var statement_return = [0,0];
        				statement_return.push({
        	                name: instance.web.datetime_to_str(new Date()),
        	                statement_id: self.cashregister.id,
        	                account_id: self.cashregister.account_id[0],
        	                journal_id: self.cashregister.journal_id[0],
        	                amount: -parseFloat(amount_for_statement),
        				})   
        				self.pos.db.cache.orders[self.pos.db.cache.orders.indexOf(order)].data.statement_ids.push(statement_return);	
        				return true
        			}
        			return true
        		});
        	}
        	while(true){
                var order_line = self.pos.get('selectedOrder').get('orderLines').at(0);
     	    	if (order_line){
            	   list_record.push({'available_qty':order_line.available_qty,
                   	'id':order_line.pos_id,
                   	'product_id':order_line.product.id,
                   	'price':order_line.price,
                      })
                      self.pos_widget.offline_pos_orders.orders[order_id].lines[order_line.pos_id].available_qty = order_line.available_qty; 
 	    		order_line.set_quantity("remove");
               }else{break;}
           }
        	self.pos_widget.offline_pos_orders.orders[order_id].amount_total = amount_total
     	   model_order.call('create_modify_order',[self.pos.cashregisters[0].journal_id[0],list_record,{'session_id':self.pos.pos_session.id}]).then(function(res){
     	    	return;
     	    },function(err,event){ 
     	    	event.preventDefault();
     	    	window.alert("Do not refresh the browser as the internet connection is down. Otherwise the modified data will be lost");
     	    	self.pos_widget.offline_pos_orders.modify_orders.push([self.pos.cashregisters[0].journal_id[0],list_record,{'session_id':self.pos.pos_session.id}]);
     	    });
        },
        
        renderElement: function() {
            var self = this;
            this._super();
            if (self.cashregister){
                    this.$el.click(function(){
                	if(self.pos_name == "Pay"){  
                			var customer = [];
                			flag = false;
                        	var checkboxes = document.querySelectorAll("input[name='sex'][type='checkbox']:checked");
                        	for(i=0;i<checkboxes.length;i++){
                        		order = checkboxes[i];
                        		if ($($(order).siblings()[0]).text() == 'unsaved'){
                        			self.pos_widget.offline_pos_orders.orders[$(order).val()]
                        		}                    		
                        	}                			
                			var order_id = parseInt($("input[name='sex'][type='checkbox']:checked").val());
                            _.each($("input[name=sex][type='checkbox']:checked"),function(line){
                            	if (! ($(line).parents('div.client-line.well').hasClass('draft') || $(line).parents('div.client-line.well').hasClass('unsaved'))){
                            		flag = true;
                            	}
                            });
                            if (flag){
                                self.pos_widget.screen_selector.show_popup('error',{
                                    'message':_t('Error: Could not Pay'),
                                    'comment':_t('Please select only draft orders'),
                                });
                                return;
                            }
                           _.each($("input[name=sex][type='checkbox']:checked"),function(line){
                        	   if ($($(line).siblings()[0]).text() != 'unsaved'){
                            	   customer.push($($(line).parent()).find("b[name='customer_id']").text())
                            	   self.pos_widget.modify_orders_widget.pay_list.push($(line).val());                         		   
                        	   }
                           });
                           if (customer.allValuesSame()){
                               var pos = new instance.web.Model('pos.order');
                               if (self.pos.get('selectedOrder').get('screen') === 'receipt'){  //TODO Why ?
                                   console.warn('TODO should not get there...?');
                                   return;
                               }
                               self.pos.get('selectedOrder').addPaymentline(self.cashregister);
//                               $("#corder_pos").hide();
//                               $("#paid_open").hide();
//                               $('#name_customer').hide();
//                               $(".content-calculate").hide();
                                 $("div.product-screen.screen").hide;
                               self.pos_widget.screen_selector.set_current_screen('payment');                        
                           }
                           else {
                        	   self.pos_widget.modify_orders_widget.pay_list = [] 
                               self.pos_widget.screen_selector.show_popup('error',{
                                   'message':_t('Error: Could not Pay'),
                                   'comment':_t('Please select the order of same customer'),
                               });                        	   
                        	   
                           }
                        }
                	if (self.pos_name == "Empty Kart"){
                		self.pos.get('selectedOrder').destroy();
                	}
                	if (self.pos_name == "Clear Selection"){
            			_.each($("input[name='sex'][type='checkbox']:checked"),function(record){
            				$(record).prop("checked",false);
            			}) ;
            	        $("button:contains('Modify Order')").attr('disabled','disabled');
            	        $("button:contains('Pay')").attr('disabled','disabled');            			
                        while(true){
  	                      var order_line = self.pos.get('selectedOrder').get('orderLines').at(0);
  	                      if (order_line){
  	                          order_line.set_quantity("remove");
  	                      }else{break;}
  	                  }
            		}
            		
                    if (self.pos_name == "Modify Order"){
                    	var template = QWeb.render('difference_total_dynamic')
                    	$('div.summary.clearfix').append(template);
                    	var checkboxes = document.querySelectorAll("input[name='sex'][type='checkbox']:checked");
                    	if (checkboxes.length > 1){
                            self.pos_widget.screen_selector.show_popup('error',{
                                message: _t('Multiple Orders cannot be modified'),
                            });
                            return;                    		
                    	}
                    	var order_save = checkboxes[0];
                    	var currentOrder = self.pos.get('selectedOrder')
                		self.pos_widget.available_qty = true;
                    	self.before_modify_total = currentOrder.getTotalTaxIncluded();
                    	$('button.input-button').bind('click',function(){
                    		var currentOrder = self.pos.get('selectedOrder')
                    		final_difference = (self.before_modify_total - currentOrder.getTotalTaxIncluded());
                    		$("input#difference_total_dynamic").val(final_difference);
                    	});
                    	if (currentOrder.getTotalTaxIncluded() < 0){
                            self.pos_widget.screen_selector.show_popup('error',{
                                message: _t('Back Orders Cannot be modified'),
                            });
                            return;
                    	}
                    	lines = self.pos.get('selectedOrder').get('orderLines')
                    	self.pos_widget.available_qty_lines = {}
                    	_.each(lines.models,function(line){
                    		self.pos_widget.available_qty_lines[line.pos_id] = line.available_qty;
                    	});
                    	$($("tr[name='products']").children()[1]).css('display','none');
                    	$("tr[name='products']").append(QWeb.render('button_pay_cancel'))
                  	    self.pos_widget.switch_to_product();
                    	$("#modify_order_cancel").click(function(){
                    	  self.pos_widget.available_qty = undefined;
                  		  self.pos.get('selectedOrder').destroy();
                          $("#modify_order").remove();
                      	  $($("tr[name='products']").children()[1]).removeAttr("style");
                      	  self.pos_widget.switch_to_order();
                    	});
                    	var model = new instance.web.Model("pos.order.line");
                    	var model_order = new instance.web.Model("pos.order");
                    	$("#modify_order_pay_cash").click(function(){
                    		self.pos_widget.available_qty = undefined;
                			self.modify_order($("#corder_pos").find("input[name='sex'][type='checkbox']:checked").val(),$($(order_save).siblings()[0]).text() == 'unsaved');
                			$("#modify_order").remove();
                    	    $($("tr[name='products']").children()[1]).removeAttr("style");
                    	    self.pos.get('selectedOrder').destroy();
                    	});
                    }            	                	
                	
                	if (self.pos_name == "Pay Cash"){
                        if (self.pos.get('selectedOrder').get('screen') === 'receipt'){  //TODO Why ?
                            console.warn('TODO should not get there...?');
                            return;
                        }
                        self.pos.get('selectedOrder').addPaymentline(self.cashregister);
                        self.pos_widget.screen_selector.set_current_screen('payment');
                    }
                    if (self.pos_name == "Credit Customer"){
                        if(!$("ul.orderlines li").first().hasClass('empty')){
                            $("#myTab li :eq(1) a").attr("data-by-pass","true");
                            $("#myTab li :eq(1) a").click();
                        }
                        
                    }
                    if (self.pos_name == "Park Order"){
                        var order_lines = [];
                        while(true){
                            var order_line = self.pos.get('selectedOrder').get('orderLines').at(0);
                            if (order_line){
                                order_line.set_quantity("remove");
                                order_lines.push(order_line);
                            }else{break;}
                        }
                        if(order_lines.length && _.keys(self.pos_widget.park_order_widget.park_orders).length < 1 || $.trim(self.$el.text()) == "Remove Park"){
                            self.pos_widget.park_order_widget.set_value(order_lines, self.$el);
                        }
                    }
                });
                return;
            }
            
            this.$el.click(function(){   
            	if (self.pos_name == "Modify Customer"){
//            		$("div.clientlist-screen.screen").css("overflow","auto");
            		$("div.screen-content").css("position","absolute");
            		$("tr#customer-down-panel").hide();
            		var model = new instance.web.Model('res.partner');
            		var custmer_id = parseInt($("input[name='sex']:checked").val());
            		if (custmer_id){
                            $(".clientlist-screen .screen-content:visible").hide();
                            var client_edit = $(QWeb.render('ClientDetailsEditNewModify',{widget:self.pos_widget.clientlist_screen, partner:self.pos.db.partner_by_id[custmer_id]}));
                            var contents = $(".clientlist-screen");
                            contents.append(client_edit);
                            contents.on('click','.button.save',function(event){ 
                            	var custmer_id = parseInt($("input[name='sex']:checked").val());
                            	event.stopImmediatePropagation();
	                            self.pos_widget.clientlist_screen.save_client_details(self.pos.db.partner_by_id[custmer_id]);
	                            $(client_edit).remove();
	                            $("tr#customer-down-panel").show();
	                            $("div.screen-content").css("position","relative");
                            });
                            contents.on('click','.button.undo',function(){
                            	self.pos_widget.clientlist_screen.undo_client_details(self.pos.db.partner_by_id[custmer_id]); 
                            	$("tr#customer-down-panel").show();
                            	$("div.screen-content").css("position","relative");
                            });
                            contents.find('.image-uploader').on('change',function(event){
                                self.pos_widget.clientlist_screen.load_image_file(event.target.files[0],function(res){
                                    if (res) {
                                        contents.find('.client-picture img, .client-picture .fa').remove();
                                        contents.find('.client-picture').append("<img src='"+res+"'>");
                                        contents.find('.detail.picture').remove();
                                        self.pos_widget.clientlist_screen.uploaded_picture = res;
                                    }
                                });
                            });
                            $("i.fa.fa-undo").click(function(){
                            	$("div.screen-content").css("position","relative");
                            });		                                		                    
            		}
            		delete custmer_id;
            	}

            	if(self.pos_name == 'All Downloaded Orders'){
//            		$("div.clientlist-screen.screen").css("overflow","auto");
            		self.pos_widget.customer_id = $("input[name='sex'][type='radio']:checked").val();
            		var name = self.pos.db.partner_by_id[self.pos_widget.customer_id].name
            		self.pos_widget.mode = 'all'
        			self.pos_widget.switch_to_order(); 
            		var client_edit = $(QWeb.render('name_customer',{name:name}));
            		$("div#orders").find("div.clientlist-screen.screen").prepend(client_edit);
            	}
            	
            	if (self.pos_name == "Show Open Orders"){
//            		$("div.clientlist-screen.screen").css("overflow","auto");
            		self.pos_widget.customer_id = $("input[name='sex'][type='radio']:checked").val();
            		self.pos_widget.mode = 'open'
        			self.pos_widget.switch_to_order();
            	}
            	
            	if (self.pos_name == 'Clear Customer Selection'){
        			_.each($("input[name='sex'][type='radio']:checked"),function(record){
        				$(record).prop("checked",false);
        			}) ;
        	        $("button:contains('Modify Customer')").attr('disabled','disabled');
        	        $("button:contains('All Downloaded Orders')").attr('disabled','disabled');
        	        $("button:contains('Show Open Orders')").attr('disabled','disabled');
        	        
            	}
            	
            	if (self.pos_name == "New Customer"){
                    //            
            		$("div.screen-content").css("position","absolute");
//            		$("div.clientlist-screen.screen").css("overflow","auto");
                    $(".clientlist-screen .screen-content:visible").hide();
            		$("tr#customer-down-panel").hide();
            		var client_edit = $(QWeb.render('ClientDetailsEditNewModify',{widget:self.pos_widget.clientlist_screen, partner:{country_id: false}}));
                    var contents = $(".clientlist-screen");
                    contents.append(client_edit);
                    contents.off('click','.button.save'); 
                    contents.off('click','.button.undo');
                    contents.on('click','.button.save',function(){ 
                    	if (!$(contents).find("input[name='sequence']").val()){
                    		self.pos_widget.clientlist_screen.save_client_details({});
                    	}
                    	$("tr#customer-down-panel").show();
            			$("div.screen-content").css("position","relative");
                    });
                    contents.on('click','.button.undo',function(){ 
                    	$("tr#customer-down-panel").show();
            			$("div.screen-content").css("position","relative");
            			self.pos_widget.clientlist_screen.undo_client_details({}); });
                    	contents.find('.image-uploader').on('change',function(event){
                        self.pos_widget.clientlist_screen.load_image_file(event.target.files[0],function(res){
                            if (res) {
                                contents.find('.client-picture img, .client-picture .fa').remove();
                                contents.find('.client-picture').append("<img src='"+res+"'>");
                                contents.find('.detail.picture').remove();
                                self.pos_widget.clientlist_screen.uploaded_picture = res;
                            }
                        });
                });
                    $("i.fa.fa-undo").click(function(){
                    	$("div.screen-content").css("position","relative");
                    });		                    
                }
            });
            
        },
    });

Array.prototype.allValuesSame = function() {

    for(var i = 1; i < this.length; i++)
    {
        if(this[i] !== this[0])
            return false;
    }

    return true;
}
 
module.ReceiptScreenWidget = module.ReceiptScreenWidget.extend({
	
    finishOrder: function() {
    	this.pos.get('selectedOrder').destroy();
    	if($("div[name='screen'].active").attr('id') == 'orders'){
    		this.pos_widget.switch_to_order();
    	}
    	else{
    		this.pos_widget.switch_to_product();
    	}
    },
});

//Creating pos_order database to avoid the round trip to local storage

module.pos_orders= module.PosBaseWidget.extend({
	
	init:function(parent){
		var self =this;
		this._super(parent);
		this.orders = [];
		this.defer = new $.Deferred;
		this.modify_orders = [];
		this.pay_list = [];
		this.fetch_orders();
		this.order_search_string = {}
		this.defer.done(function(){
			_.each(self.orders,function(order){
				str = ""
				if (order.partner_id && order.partner_id[1] != 'false'){
					str += order.partner_id[1];
				}
				if (order.name && order.name != 'false'){
					str += " | " + order.name   ;
				}
				if (order.sequence_partner && order.sequence_partner != 'false'){
					str += " | " +  order.sequence_partner ;
				}
				if (order.date_order && order.date_order != 'false'){
					str += " | " + order.date_order ;
				}
				if (order.partner_id && order.partner_id[1] != false){
					str += " | " + order.partner_id ;
				}
				self.order_search_string[order.id] = this.str
			});
			return;
		});
	},
	search_string:function(){
		var self =this;
	},
	fetch_orders:function(){
		var self = this;
		var model = new instance.web.Model('pos.order');
		return model.call('fetch_pos_order',{
			context:{}
			}).done(function(data){
				self.orders =  data;
				self.defer.resolve()
				
		});
	},
});

module.modify_orders = module.PosBaseWidget.extend({
	init:function(parent){
		this._super(parent);
		var self = this;
		this.orders= {};
		this.pay_list = [];
	},
	
	show_product_on_select:function(out_this){
		var self = this;
		list_orders = [];
		customer_id = [];
		var d1 = new $.Deferred();
		var details_order;
		orders_checked = self.get_checked_orders();
		_.each(orders_checked,function(order){
			if (order.checked){
				list_orders.push($(order).parent().prev().text());
				if ($(order).parent().children()[3]){
					customer_id.push($($(order).parent()).find("b[name='customer_id']").text())
				}
			}
		});
		if (customer_id.allValuesSame()){
			var product_model = new instance.web.Model('product.product');
			var model = new instance.web.Model('pos.order.line');
			_.each(orders_checked,function(res){
				checked_id = $(res).val()
				order = self.pos_widget.offline_pos_orders.orders[checked_id]
				_.each(order.lines,function(line){
					self.pos.get('selectedOrder').addProduct(line.product,{quantity:line.qty, price:line.price_unit, discount:line.discount, pos_id:line.id, available_qty:line.available_qty});
				})
			});
		}
		
	},
	
	get_checked_orders:function(){
		return $("input[name='sex'][type='checkbox']:checked");
	}
})    
module.park_orders = module.PosBaseWidget.extend({
    init: function(parent, options){
        this._super(parent);
        var self = this;
        this.park_orders = {};
        this.park_button = options['park_button'];
        this.$el = null;
    },
    remove_park: function($el){
        var self = this;
        if ($("ul.orderlines li").first().hasClass('empty')){
            var order_unique = _.keys(this.park_orders);
            if (order_unique.length){
                _.each(self.park_orders[order_unique], function(line){
                	self.pos.get('selectedOrder').addOrderline(line);
                });
            }
            delete self.park_orders[order_unique];
            this.hide_park($el);
        }
    },
    hide_park: function($el){
        $el.text("Park Order");
    },
    show_park: function($el){
        $el.text("Remove Park");
    },
    set_value: function(order_lines, $el){
        if ($.trim($el.text()) !== "Park Order"){
            return this.remove_park($el);
        }
        var u_id = this.get_unique_id();
        this.park_orders[u_id] =  order_lines;
        this.show_park($el);
    },
    get_unique_id: function(){
        return _.uniqueId('park_order_');
    },
});
instance.point_of_sale.ScreenSelector = instance.point_of_sale.ScreenSelector.extend({
        set_current_screen: function(screen_name,params,refresh){
            var screen = this.screen_set[screen_name];
            if(!screen){
                console.error("ERROR: set_current_screen("+screen_name+") : screen not found");
            }

            this.close_popup();

            var order = this.pos.get('selectedOrder');
            var old_screen_name = order.get_screen_data('screen');

            order.set_screen_data('screen',screen_name);

            if(params){
                order.set_screen_data('params',params);
            }

            if( screen_name !== old_screen_name ){
                order.set_screen_data('previous-screen',old_screen_name);
            }
            if ( refresh || screen !== this.current_screen){
                if(this.current_screen && screen_name !== 'clientlist'){
                	this.current_screen.close();
                    this.current_screen.hide();
                }
                this.current_screen = screen;
                this.current_screen.show();
            }
        },

});
instance.point_of_sale.ClientListScreenWidget = instance.point_of_sale.ClientListScreenWidget.extend({
    show_leftpane: true,
        show: function(){
            var self = this;
            this._super();
            this.renderElement();
            this.details_visible = false;
            this.old_client = this.pos.get('selectedOrder').get('client');
            this.new_client = this.old_client;

            this.$('.back').click(function(){
                self.pos_widget.screen_selector.back();
            });

            this.$('.next').click(function(){
                self.save_changes();
                self.pos_widget.screen_selector.back();
            });

            this.$('.new-customer').click(function(){
                self.display_client_details('edit',{
                    'country_id': self.pos.company.country_id,
                });
            });
            var partners = this.pos.db.get_partners_sorted();
            this.render_list(partners);
            this.reload_partners();
            if( this.old_client ){
                this.display_client_details('show',this.old_client,0);
            }

            this.$('.client-list-contents').delegate('.client-line','click',function(event){
                self.line_select(event,$(this),parseInt($(this).data('id')));
            });

            var search_timeout = null;

            if(this.pos.config.iface_vkeyboard && this.pos_widget.onscreen_keyboard){
                this.pos_widget.onscreen_keyboard.connect($('#search_customers input'));
            }

            $('#search_customers input').on('keyup',function(event){
                clearTimeout(search_timeout);

                var query = this.value;

                search_timeout = setTimeout(function(){
                    self.perform_search(query,event.which === 13);
                },70);
            });

            $('#search_customers .search-clear').click(function(){
                self.clear_search();
            });
        },

    render_list: function(partners){
            var self = this;
            var contents = this.$el[0].querySelector('.client-list-contents');
            contents.innerHTML = "";
            for(var i = 0, len = Math.min(partners.length,1000); i < len; i++){
                var partner    = partners[i];
                var clientline_html = QWeb.render('ClientLine',{widget: this, partner:partners[i]});
                var clientline = document.createElement('tbody');
                clientline.innerHTML = clientline_html;
                clientline = clientline.childNodes[1];
                if( partners === this.new_client ){
                    clientline.classList.add('highlight');
                }else{
                    clientline.classList.remove('highlight');
                }
                $(clientline).find("input[name=sex]").change(function(event) {
                    var custmer_id = parseInt($('input[name=sex]:checked').val());
                    if (!$("ul.orderlines li").first().hasClass('empty') && custmer_id){
                        if(confirm("Are you sure about the selection")){
                            var currentOrder = self.pos.get('selectedOrder');
                            currentOrder.set_client(self.pos.db.get_partner_by_id(custmer_id));
                            self.pos.push_order(currentOrder); 
                            self.pos.get('selectedOrder').destroy();
                            $("#myTab li :eq(0) a").click();
                        }else{
                            $('input[name=sex]:checked').attr("checked", false);
                        }
                    }
                });
                contents.appendChild(clientline);
            }
        },
    save_client_details: function(partner) {
    		var self = this;
            var fields = {};
            $(".client-details:visible").find(".detail").each(function(idx,el){
                fields[el.name] = el.value;
            });
            if (!fields.name) {
            	$("section.client-details.edit").remove();
            	this.pos_widget.screen_selector.show_popup('error',{
                    message: _t('A Customer Name Is Required'),
                });
                return;
            }
            
            if (this.uploaded_picture) {
                fields.image = this.uploaded_picture;
            }

            fields.id           = partner.id || false;
            fields.country_id   = fields.country_id || false;
            fields.ean13        = fields.ean13 ? this.pos.barcode_reader.sanitize_ean(fields.ean13) : false; 
            if (partner['sequence']){
            	delete partner['sequence'];
            }
            new instance.web.Model('res.partner').call('create_from_ui',[fields]).then(function(partner_id){
            	self.saved_client_details(partner_id);
            },function(err,event){
                event.preventDefault();
                self.pos_widget.screen_selector.show_popup('error',{
                    'message':_t('Error: Could not Save Changes'),
                    'comment':_t('Your Internet connection is probably down.'),
                });
            });
    },
    undo_client_details: function(){
        $("section.client-details").remove();
        $(".clientlist-screen .screen-content").show();
    },
    saved_client_details: function(partner_id){
        var self = this;
        this.reload_partners().then(function(){
            $("section.client-details").remove();
            $(".clientlist-screen .screen-content").show();
        });
    },
});
instance.point_of_sale.ProductCategoriesWidget = instance.point_of_sale.ProductCategoriesWidget.extend({
	
	init:function(parent,options){
		var self = this;
		this._super(parent,options);
		this.switch_category_back = function(event){
			if (self.breadcrumb.length > 1){
				self.set_category(self.pos.db.get_category_by_id(self.breadcrumb[self.breadcrumb.length - 2].id));
			}
			else{
				self.set_category(self.pos.db.get_category_by_id(Number(this.dataset['categoryId'])))
			}
			self.renderElement();
		};
	},
	display_breadcrumb:function(list_container,hasimages){
		var self = this;
        count_category = 0;
		while (count_category < this.subcategories.length){
    		if (count_category == this.subcategories.length ){
    			return;
    		}
    		list_container.appendChild(this.render_category(this.subcategories[count_category],hasimages));
    		count_category++;
    		if ($(list_container).children().length == 3){
    			list_container = document.createElement('div')
    			$(list_container).attr('class','category-list-custom oe_hidden')
    			$("#breadcrumbs").append($(list_container));
    		}
		}
		return;
	},
	go_back_category:function(){
		index = $("div.category-list-custom:not(.oe_hidden)").index();
		length = $("#breadcrumbs").children().length;
		if (index == 0){
			return;
		} 
		$("div.category-list-custom:not(.oe_hidden)").addClass('oe_hidden');
		$($($("#breadcrumbs").children()[index-1])[0]).removeClass('oe_hidden')		
	},
	go_next_category:function(){
		index = $("div.category-list-custom:not(.oe_hidden)").index();
		length = $("#breadcrumbs").children().length;
		if($($("#breadcrumbs").children()[index+1]).children().length == 0){
			return;
		} 
		if (index == length-1){
			return;
		}
		$("div.category-list-custom:not(.oe_hidden)").addClass('oe_hidden');
		$($($("#breadcrumbs").children()[index+1])[0]).removeClass('oe_hidden')
	},
	renderElement: function(){
        var self = this;

        var el_str  = openerp.qweb.render(this.template, {widget: this});
        var el_node = document.createElement('div');
            el_node.innerHTML = el_str;
            el_node = el_node.childNodes[1];

        if(this.el && this.el.parentNode){
            this.el.parentNode.replaceChild(el_node,this.el);
        }

        this.el = el_node;

        var hasimages = false;  //if none of the subcategories have images, we don't display buttons with icons
        for(var i = 0; i < this.subcategories.length; i++){
            if(this.subcategories[i].image){
                hasimages = true;
                break;
            }
        }
        
        
        var list_container = el_node.querySelector('.category-list-custom');
        if (list_container) { 
            if (!hasimages) {
                list_container.classList.add('simple');
            } else {
                list_container.classList.remove('simple');
            }
            this.display_breadcrumb(list_container,hasimages);
        }
        
        var div_buttons = el_node.querySelectorAll('#back');
        for (var i = 0;i<div_buttons.length;i++){
        	div_buttons[i].addEventListener('click',this.go_back_category);
        }
        var div_buttons = el_node.querySelectorAll('#next');
        for (var i = 0;i<div_buttons.length;i++){
        	div_buttons[i].addEventListener('click',this.go_next_category);
        }        
        var buttons = el_node.querySelectorAll('.js-category-back');
        for(var i = 0; i < buttons.length; i++){
            buttons[i].addEventListener('click',this.switch_category_back);
        }        
        
        buttons = el_node.querySelectorAll('.js-category-switch');
        for(var i = 0; i < buttons.length; i++){
            buttons[i].addEventListener('click',this.switch_category_handler);
        }

        var products = this.pos.db.get_product_by_category(this.category.id);
        this.product_list_widget.set_product_list(products);
        this.el.querySelector('#search_products input').addEventListener('keyup',this.search_handler);

        this.el.querySelector('#search_products .search-clear').addEventListener('click',this.clear_search_handler);

        if(this.pos.config.iface_vkeyboard && this.pos_widget.onscreen_keyboard){
            this.pos_widget.onscreen_keyboard.connect($(this.el.querySelector('#search_products input')));
        }
    },

    render_category: function( category, with_image ){
        with_image = false;
        var cached = this.category_cache.get_node(category.id);
        if(!cached){
              var category_html = QWeb.render('CategorySimpleButton',{ 
                    widget:  this, 
                    category: category, 
                });
                category_html = _.str.trim(category_html);
                var category_node = document.createElement('div');
                category_node.innerHTML = category_html;
                category_node = category_node.childNodes[0];
                this.category_cache.cache_node(category.id,category_node);
                return category_node;
        }
        return cached; 
        },

});
instance.point_of_sale.HeaderButtonWidget = instance.point_of_sale.HeaderButtonWidget.extend({
    init: function(parent, options){
        this._super.apply(this, arguments);
        this.label = _t('Log out');
        this.action = function(){var self=this; return self.pos_widget.close();};
    },
    appendTo: function(){
        this._super.apply(this, arguments);
    }
});
instance.point_of_sale.UsernameWidget = instance.point_of_sale.UsernameWidget.extend({
    get_name: function(){
            var user;
            if(this.mode === 'cashier'){
                user = this.pos.cashier || this.pos.user;
            }else{
                user = this.pos.get('selectedOrder').get_client()  || this.pos.user;
            }
            if(user){
                return "Welcome, "+user.name;
            }else{
                return "";
            }
        },
});

instance.point_of_sale.PosModel = instance.point_of_sale.PosModel.extend({

    initialize: function(session, attributes) {
        Backbone.Model.prototype.initialize.call(this, attributes);
        var  self = this;
        this.session = session;                 
        this.flush_mutex = new $.Mutex();                   // used to make sure the orders are sent to the server once at time
        this.pos_widget = attributes.pos_widget;

        this.proxy = new module.ProxyDevice(this);              // used to communicate to the hardware devices via a local proxy
        this.barcode_reader = new module.BarcodeReader({'pos': this, proxy:this.proxy, patterns: {}});  // used to read barcodes
        this.proxy_queue = new module.JobQueue();           // used to prevent parallels communications to the proxy
        this.db = new module.PosDB();                       // a local database used to search trough products and categories & store pending orders
        this.debug = jQuery.deparam(jQuery.param.querystring()).debug !== undefined;    //debug mode 
        
        // Business data; loaded from the server at launch
        this.accounting_precision = 2; //TODO
        this.company_logo = null;
        this.company_logo_base64 = '';
        this.currency = null;
        this.shop = null;
        this.company = null;
        this.user = null;
        this.users = [];
        this.partners = [];
        this.cashier = null;
        this.cashregisters = [];
        this.bankstatements = [];
        this.taxes = [];
        this.pos_session = null;
        this.config = null;
        this.units = [];
        this.units_by_id = {};
        this.pricelist = null;
        this.order_sequence = 1;
        window.posmodel = this;
        
        // these dynamic attributes can be watched for change by other models or widgets
        this.set({
            'synch':            { state:'connected', pending:0 }, 
            'orders':           new module.OrderCollection(),
            'selectedOrder':    null,
        });
        this.bind('change:synch',function(pos,synch){
        	clearTimeout(self.synch_timeout);
            self.synch_timeout = setTimeout(function(){
                if(synch.state !== 'disconnected' && synch.pending > 0){
                    self.set('synch',{state:'disconnected', pending:synch.pending});
                }
            },3000);
        });
        window.addEventListener("online", function(e) {
        	var a = navigator.onLine;
        	if (a){
        		self.set('synch',{state:'connected', pending:self.get('synch').pending});
        		if (self.db.cache.orders.length > 0){
        			self.push_order();
        		}
        		if (self.pos_widget.offline_pos_orders && self.pos_widget.offline_pos_orders.pay_list.length > 0 ){
        			setTimeout(self.pos_widget.pos.pay_orders(),30000);
        		}
        		if (self.pos_widget.offline_pos_orders && self.pos_widget.offline_pos_orders.modify_orders.length > 0){
        			setTimeout(self.pos_widget.pos.modify_order(),30000);
        		}
        	}else{
        		self.set('synch',{state:'disconnected', pending:self.get('synch').pending});
        	}
        });

        this.get('orders').bind('remove', function(order,_unused_,options){ 
            self.on_removed_order(order,options.index,options.reason); 
        });
        
        // We fetch the backend data on the server asynchronously. this is done only when the pos user interface is launched,
        // Any change on this data made on the server is thus not reflected on the point of sale until it is relaunched. 
        // when all the data has loaded, we compute some stuff, and declare the Pos ready to be used. 
        this.ready = this.load_server_data()
            .then(function(){
                if(self.config.use_proxy){
                    return self.connect_to_proxy();
                }
            });
        
    },	
	
	_flush_orders: function(orders, options) {
        var self = this;
        this.set('synch',{ state: 'connecting', pending: orders.length});

        return self._save_to_server(orders, options).done(function (server_ids) {
            var pending = self.db.get_orders().length;
            self.set('synch', {
                state: pending ? 'connecting' : 'connected',
                pending: pending
            });
            return server_ids;
        });
    },

    // send an array of orders to the server
    // available options:
    // - timeout: timeout for the rpc call in ms
    // returns a deferred that resolves with the list of
    // server generated ids for the sent orders
    _save_to_server: function (orders, options) {
        if (!orders || !orders.length) {
            var result = $.Deferred();
            result.resolve([]);
            return result;
        }
            
        options = options || {};

        var self = this;
        var timeout = typeof options.timeout === 'number' ? options.timeout : 7500 * orders.length;

        // we try to send the order. shadow prevents a spinner if it takes too long. (unless we are sending an invoice,
        // then we want to notify the user that we are waiting on something )
        var posOrderModel = new instance.web.Model('pos.order');
        return posOrderModel.call('create_from_ui',
            [_.map(orders, function (order) {
            	order.to_invoice = options.to_invoice || false;
                return order;
            })],
            undefined,
            {
                shadow: !options.to_invoice,
                timeout: timeout
            }
        ).then(function (server_ids) {
            _.each(orders, function (order) {
                self.db.remove_order(order.id);
                delete self.pos_widget.offline_pos_orders.orders[order.id];
            	self.pos_widget.get_order(); 

            });
            _.each(server_ids,function(order){
            	self.pos_widget.offline_pos_orders.orders[order.id] = order
            });
            
            return server_ids;
        }).fail(function (error, event){
        	if(error.code === 200 ){    // Business Logic Error, not a connection problem
        		self.pos_widget.screen_selector.show_popup('error-traceback',{
                    message: error.data.message,
                    comment: error.data.debug
                });
            }
            // prevent an error popup creation by the rpc failure
            // we want the failure to be silent as we send the orders in the background
            event.preventDefault();
            console.error('Failed to send orders:', orders);
        });
    },
	add_order:function(order){
    	var self = this;
    	var today = new Date();
		console.log(self.pos_widget.offline_pos_orders.orders);
    	console.log(self);
    	if (!(order.name in self.pos_widget.offline_pos_orders.orders)){
    		var line_list = {}
    		var partner_id = []
    		var sequence_partner = undefined 
    		if (order.partner_id){
    			partner_id.push(order.partner_id)
    			partner_id.push(self.db.partner_by_id[order.partner_id].name)
    			sequence_partner = self.db.partner_by_id[order.partner_id].sequence
    		}
    		else{
    			partner_id = undefined;
    		}
    		for(i=0;i<order.lines.length;i++){
    			line_list[i] = {
                        'id': i,
                        'qty':order.lines[i][2].qty,
                        'price_unit':order.lines[i][2].price_unit,
                        'discount':order.lines[i][2].discount,
                        'available_qty':order.lines[i][2].qty,
                        'return_qty':0,
                        'product':self.db.product_by_id[order.lines[i][2].product_id],
                        'pos_id':i,
    			}
    		}
			self.pos_widget.offline_pos_orders.orders[order.name.split(' ')[1]] = {
    				'id':undefined,
    				'state':'unsaved',
    				'name':order.name,
    				'date_order':today.getFullYear() + '-' + parseInt(today.getMonth()+1) + '-' + today.getDate()+ ' ',
    				'amount_total':order.amount_total,
    				'partner_id':partner_id,
    				'sequence_partner':sequence_partner,
    				'lines': line_list,
    		}
    	}else{
    		console.log("The order already exists in Database");
    		return;
    	}
    },
    pay_orders:function(){
    	var self =this;
    	var model = new instance.web.Model('pos.order')
		if (self.pos_widget.offline_pos_orders && self.pos_widget.offline_pos_orders.pay_list){
	    	model.call('offline_payment_recieved',[self.pos_widget.offline_pos_orders.pay_list]).then(function(){
				self.pos_widget.offline_pos_orders.pay_list.length = 0;
			},function(err,event){
				event.preventDefault();
			});  				
		}
    },
    
    modify_order:function(){
    	var self =this;
    	var model = new instance.web.Model('pos.order')
    	if (self.pos_widget.offline_pos_orders && self.pos_widget.offline_pos_orders.modify_orders){
    		model.call('create_modify_order_list',[self.pos_widget.offline_pos_orders.modify_orders]).then(function(){
    			self.pos_widget.offline_pos_orders.modify_orders.length = 0;
    		},function(err,event){
    			event.preventDefault();
    		});  	    		
    	}
    },
    
	push_order: function(order) { //indicator
        var self = this;
        if(order){
            this.proxy.log('push_order',order.export_as_JSON());
            this.db.add_order(order.export_as_JSON());
            this.add_order(order.export_as_JSON());
        }
        var pushed = new $.Deferred();
        this.flush_mutex.exec(function(){
        	var flushed = self._flush_orders(self.db.get_orders());
            flushed.always(function(ids){
            	pushed.resolve();
            });
        });
        return pushed;
    },
});

instance.point_of_sale.PosWidget = instance.point_of_sale.PosWidget.extend({
    start:function(){
    	var self = this;
    	this._super();
    	self.pos.modify_order();
    	self.pos.pay_orders();
    },
    
	build_widgets: function() {
        var self = this;
        // --------  Screens ---------

        this.product_screen = new module.ProductScreenWidget(this,{});
        this.product_screen.appendTo(this.$('.screens'));

        this.receipt_screen = new module.ReceiptScreenWidget(this, {});
        this.receipt_screen.appendTo(this.$('.screens'));

        this.payment_screen = new module.PaymentScreenWidget(this, {});
        this.payment_screen.appendTo(this.$('.screens'));

        this.clientlist_screen = new module.ClientListScreenWidget(this, {});
        this.clientlist_screen.appendTo(this.$('#customers'));

        this.scale_screen = new module.ScaleScreenWidget(this,{});
        this.scale_screen.appendTo(this.$('.screens'));


        // --------  Popups ---------

        this.error_popup = new module.ErrorPopupWidget(this, {});
        this.error_popup.appendTo(this.$el);

        this.error_barcode_popup = new module.ErrorBarcodePopupWidget(this, {});
        this.error_barcode_popup.appendTo(this.$el);

        this.error_traceback_popup = new module.ErrorTracebackPopupWidget(this,{});
        this.error_traceback_popup.appendTo(this.$el);

        this.confirm_popup = new module.ConfirmPopupWidget(this,{});
        this.confirm_popup.appendTo(this.$el);

        this.unsent_orders_popup = new module.UnsentOrdersPopupWidget(this,{});
        this.unsent_orders_popup.appendTo(this.$el);

        // --------  Misc ---------

        this.close_button = new module.HeaderButtonWidget(this,{
            label: _t('Close'),
            action: function(){ 
                var self = this;
                if (!this.confirmed) {
                    this.$el.addClass('confirm');
                    this.$el.text(_t('Confirm'));
                    this.confirmed = setTimeout(function(){
                        self.$el.removeClass('confirm');
                        self.$el.text(_t('Close'));
                        self.confirmed = false;
                    },2000);
                } else {
                    clearTimeout(this.confirmed);
                    this.pos_widget.close();
                }
            },
        });
        this.close_button.appendTo(this.$('.pos-rightheader'));
        this.notification = new module.SynchNotificationWidget(this,{});
        this.notification.appendTo(this.$('.pos-rightheader'));

        if(this.pos.config.use_proxy){
            this.proxy_status = new module.ProxyStatusWidget(this,{});
            this.proxy_status.appendTo(this.$('.pos-rightheader'));
        }

        this.username   = new module.UsernameWidget(this,{});
        this.username.replace(this.$('.placeholder-UsernameWidget'));

        this.action_bar = new module.ActionBarWidget(this);
        this.action_bar.replace(this.$(".placeholder-RightActionBar"));

        this.paypad = 
            new module.PaypadWidget(this, {template:'ProductPaypadButtonWidget',screen: "products", buttons: ["Pay Cash", "Credit Customer", "Park Order","Empty Kart"]});
        this.paypad.replace(this.$('.placeholder-PaypadWidget'));
        
        
        this.customer_paypad = 
            new module.PaypadWidget(this, {template:'CustomerPaypadButtonWidget', screen:"customers", buttons:['New Customer', 'Modify Customer']});
        this.customer_paypad.replace(this.$('.placeholder-PaypadWidget-customer'));
        
        this.customer_paypad_order = 
            new module.PaypadWidget(this, {template:'CustomerPaypadButtonWidget', screen:"customers", buttons:["Show Open Orders", "All Downloaded Orders","Clear Customer Selection"]});
        this.customer_paypad_order.replace(this.$('.placeholder-PaypadWidget-customer-order'));        
        
        this.order_paypad = 
        new module.PaypadWidget(this, {template:'OrderPaypadButtonWidget', screen:"orders", buttons:["Pay", "Modify Order"]});
        this.order_paypad.replace(this.$('.placeholder-PaypadWidget-order-left'));
        
        this.order_paypad_right = 
        new module.PaypadWidget(this, {template:'OrderPaypadButtonWidget', screen:"orders", buttons:["Clear Selection"]});
        this.order_paypad_right.replace(this.$('.placeholder-PaypadWidget-order-right'));
        
        this.numpad = new module.NumpadWidget(this);
        this.numpad.replace(this.$('.placeholder-NumpadWidget'));

        this.order_widget = new module.OrderWidget(this, {});
        this.order_widget.replace(this.$('.placeholder-OrderWidget'));

        this.onscreen_keyboard = new module.OnscreenKeyboardWidget(this, {
            'keyboard_model': 'simple'
        });
        this.onscreen_keyboard.replace(this.$('.placeholder-OnscreenKeyboardWidget'));
        
        // --------  Screen Selector ---------

        this.screen_selector = new module.ScreenSelector({
            pos: this.pos,
            screen_set:{
                'products': this.product_screen,
                'payment' : this.payment_screen,
                'scale':    this.scale_screen,
                'receipt' : this.receipt_screen,
                'clientlist': this.clientlist_screen,
            },
            popup_set:{
                'error': this.error_popup,
                'error-barcode': this.error_barcode_popup,
                'error-traceback': this.error_traceback_popup,
                'confirm': this.confirm_popup,
                'unsent-orders': this.unsent_orders_popup,
            },
            default_screen: 'products',
            default_mode: 'cashier',
        });

        if(this.pos.debug){
            this.debug_widget = new module.DebugWidget(this);
            this.debug_widget.appendTo(this.$('.pos-content'));
        }

        $("#orders").append(QWeb.render('CorderScreenWidget'));
        this.disable_rubberbanding();
        this.enable_customize();
        this.modify_orders_widget = new module.modify_orders(this);
        this.offline_pos_orders = new module.pos_orders(this);
        this.get_order();
        this.park_order_widget = new module.park_orders(this, {"park_button": this.paypad.$el.children().last()});
        self.$el.click(function(event){
            var target = event.target || event.srcElement;
        	if ($(target).attr('type') == 'radio'){
        		if ($("input[name='sex']:checked").length > 0){
        			$("button:contains('Show Open Orders')").removeAttr('disabled');
        		    $("button:contains('All Downloaded Orders')").removeAttr('disabled');        			
        		    $("button:contains('Modify Customer')").removeAttr('disabled');
        		}
        	} 
        });
        $(document).bind('DOMSubtreeModified',function(){
         if ($($("ul.orderlines").children()[0]).hasClass("empty")){
      		  $("button.paypad-button:contains('Pay Cash')").attr("disabled","disabled")
      		  $("button.paypad-button:contains('Park Order')").attr("disabled","disabled")
      		  $("button.paypad-button:contains('Credit Customer')").attr("disabled","disabled")
      		  $("button.paypad-button:contains('Remove Park')").removeAttr("disabled");
      	  }
      	  else{
      		  $("button.paypad-button:contains('Remove Park')").attr("disabled","disabled");
      		  $("button.paypad-button:contains('Pay Cash')").removeAttr("disabled");
      		  $("button.paypad-button:contains('Park Order')").removeAttr("disabled");
      		  $("button.paypad-button:contains('Credit Customer')").removeAttr("disabled");
      	  }
      	});        
    },
    switch_to_product:function(){
        var self = this;
        var ss = self.pos.pos_widget.screen_selector;
        $("a[data-toggle='tab']").parent().removeClass('active');
        $("a[data-toggle='tab'][href='#products']").parent().addClass('active');
        ss.set_current_screen('products');
        $(".rightpane-header .searchbox").hide();
        $(".rightpane-header #search_products").show();
        $(".rightpane-header .breadcrumb").show();
        $("#down-panel tr").hide();
        $(".rightpane-header .category-list-custom").show();
        $("#product-down-panel").show();
        $("div[name='screen'].tab-pane").removeClass("active");
        $("div#products").addClass("active");        	  
    },
    switch_to_customer:function(){
        var self = this;
        var ss = self.pos.pos_widget.screen_selector;
        ss.set_current_screen('clientlist');
        $("a[data-toggle='tab']").parent().removeClass('active');
        $("a[data-toggle='tab'][href='#customers']").parent().addClass('active');
        $("input[name='sex'][type='radio']").prop("checked",false);
	    $("button:contains('Show Open Orders')").attr('disabled','disabled');
	    $("button:contains('All Downloaded Orders')").attr('disabled','disabled');
	    $("button:contains('Modify Customer')").attr('disabled','disabled');
        $(".rightpane-header .category-list-custom").hide();
        $(".rightpane-header .breadcrumb").hide();
        $(".rightpane-header .searchbox").hide();
        $(".rightpane-header #search_customers").show();
        $("#down-panel tr").hide();
        $("#customer-down-panel").show();
		$("div.screen-content").css("position","relative");
        $("div[name='screen'].tab-pane").removeClass("active");
        $("div#customers").addClass("active");        	  
    },
    // when the filter of state or date is used this function will be called
    on_change_filter_order:function(){  
    	var from = $('input#date_from').val();
    	var to  = $("input#date_to").val();
    	_.each($("tbody#corder_pos").children(),function(order){
        		date = $(order).find("b[name='date']").text();
        		state  = $(order).find("div[name='state']").text();
        		filter_state = $('select#paid_open').val();
				$(order).show()
				if (date){
	    			date = new Date(date)
	    			if (from){from = new Date(from);}else{from = new Date();}
	    			if (to){to = new Date(to);}else{to = new Date();}
	    			if (date >= from && date <= to){$(order).show();}else{$(order).hide();}
				}else{$(order).hide()}
    	});    	
    },
    switch_to_order:function(customer_name){
        var self = this;
        var ss = self.pos.pos_widget.screen_selector;
        ss.set_current_screen('products');
        if (this.pos_widget.customer_id && self.pos_widget.mode == 'all'){
        	self.get_order(this.pos_widget.customer_id,['invoiced','done','paid','draft']); 
        }
        else if (this.pos_widget.customer_id && self.pos_widget.mode == 'open'){
        	self.get_order(this.pos_widget.customer_id,['draft']);
        }
        else{
        	self.get_order();
        }

        //so that it appears only once -- date range
        $('div#date_range').remove();
            var $date = QWeb.render('date_range',{})
        	$("#order-down-panel").append($date);
        	
        //so that it appears only once paid/open filter
        if (customer_name != 1){ // this comparison is done so that it is not removed when we download orders based on date
            	$("div#name_customer").remove();
        }        
	    
//Filter based on date has been removed but
//        $(document).on('change','select#paid_open',function(event){
//        	self.on_change_filter_order();
//        });
        

        $('button#date_range_button').on('click',function(event){
        	self.on_change_filter_order();
        });
        $('button#date_range_button_download').on('click',function(event){
        	var domain = [['amount_total','>=',0],['state','in',['draft','invoiced','paid','done']]];
        	date_from = $('input#date_from_download').val();
        	date_to = $('input#date_to_download').val();
    		self.pos_widget.customer_id = $("input[name='sex'][type='radio']:checked").val();
    		if (self.pos_widget.customer_id){
    			domain.push(['partner_id','=',parseInt(self.pos_widget.customer_id)])
    		}
    		if (date_from){
    			domain.push(['date_order','>=',date_from]);
    		}
    		if (date_to){
    			domain.push(['date_order','<=',date_to]);
    		}
    		var model = new instance.web.Model('pos.order');
    		model.call('fetch_pos_order_domain',{ 
    			context:{},
    			domain:domain,
    			}).then(function(data){
    				_.each(data,function(order){
    					if (self.pos_widget.offline_pos_orders.orders[order.id] == undefined){
    						self.pos_widget.offline_pos_orders.orders[order.id] = order
    					}
    				});
            		self.pos_widget.mode = 'all'
        			self.pos_widget.switch_to_order(customer_name = 1);
			},function(err,event){
				window.alert("Not able to download any orders as the Internet Connection is down");
				event.preventDefault();
			});
        });
        
        this.pos_widget.customer_id = undefined;
        this.pos_widget.mode = undefined;
        $("a[data-toggle='tab']").parent().removeClass('active');
        $("a[data-toggle='tab'][href='#orders']").parent().addClass('active');
        $("#corder_pos").show();
        $("button:contains('Modify Order')").attr('disabled','disabled');
        $("button:contains('Pay')").attr('disabled','disabled');
        $(".rightpane-header .breadcrumb").hide();
        $(".rightpane-header .category-list-custom").hide();
        $(".rightpane-header .searchbox").hide();
        $(".rightpane-header #search_orders").show();
        $("#down-panel tr").hide();
        $("#order-down-panel").show();
        $("div.screen-content").css("position","relative");
        $("div[name='screen'].tab-pane").removeClass("active");
        $("div#orders").addClass("active");
        var search_timeout = null;
    },
    enable_customize: function(){
        var self = this;
        this.clock();
        $('#myTab a').click(function (e,v) {
          e.preventDefault();
          var check = $("#myTab li :eq(1) a").attr('data-by-pass');
          $("#myTab li :eq(1) a").removeAttr('data-by-pass');
          var href = $(e.currentTarget).attr('href');
          var checkboxes = document.querySelectorAll("input[name='sex'][type='checkbox']:checked");
          if (!check && !$("ul.orderlines li").first().hasClass('empty') && (href == "#customers" || href == "#orders" || href == "#products")){
        	  return;
          } 
          if ($("section.client-details.edit").length > 0){
        	  return;
          }
          $(this).tab('show');
          if (href == "#customers"){
            self.switch_to_customer();
          }
          if (href == "#products"){
              self.switch_to_product();
          }
          if (href == "#orders"){
              self.switch_to_order();
          }
        });
    },
    
    check_property_object:function(order,property){
    	value = order[0][property];
    	switchs = 0;
    	_.each(order,function(order_line){
    		if (value != order_line[property]){
    			switchs = 1;
    		}
    	});
    	return switchs;
    },
    
    get_checked_order_details:function(){
    	order = []
    	var checkboxes = document.querySelectorAll("input[name='sex'][type='checkbox']:checked");
    	_.each(checkboxes,function(order_line){
    		record = {}
    		_.each($(order_line).siblings(),function(properties){
    			if ($(properties).attr('name') != undefined){
    				record[$(properties).attr('name')] = $(properties).text();
    			}
    		})
    		order.push(record);
    	});
    	return order;
    },

    change_event:function(customer_id,args){
        var self = this;
    	$("#corder_pos").find("input[name='sex'][type='checkbox']").change(function(event) {
     	   event.stopImmediatePropagation();
     	   order = self.get_checked_order_details();
     	   if (order.length !=0){
     		   if (self.check_property_object(order,'customer_id') == 1){
                    self.screen_selector.show_popup('error',{
                        'message': _t('Error'),
                        'comment': _t('Please select the orders with same customer'),
                    });
                    $(event.srcElement).prop('checked',false);
                    return;
     		   }
     		   if (self.check_property_object(order,'state') == 1){
                    self.screen_selector.show_popup('error',{
                        'message': _t('Error'),
                        'comment': _t('Please select the orders with same state'),
                    });
                    $(event.srcElement).prop('checked',false);
                    return;
     		   }           		   
     	   }
     	   
     	   var checkboxes = document.querySelectorAll("input[name='sex'][type='checkbox']:checked");
            _.each(checkboxes,function(record){
          	  if (parseFloat($($(record).siblings()[3]).text().split("$")[1]) < 0){
                   self.screen_selector.show_popup('error',{
                       'message': _t('Error'),
                       'comment': _t('Cannot pay or modify back order'),
                   });
                   $(record).prop("checked",false);
         	  } 
            });
     	   while(true){
                var order_line = self.pos.get('selectedOrder').get('orderLines').at(0);
                if (order_line){
                    order_line.set_quantity("remove");
                }else{break;}
            }        	   
     	   self.order = new module.modify_orders(self);
     	   self.order.show_product_on_select();
     	   if (checkboxes.length > 0 ){
     		   $("button:contains('Pay')").removeAttr('disabled');
     	   }
     	   if (checkboxes.length == 0 ){
     		   $("button:contains('Pay')").attr('disabled','disabled');
     	   }        	   
     	   if (checkboxes.length != 1){
     		   $("button:contains('Modify Order')").attr('disabled','disabled');
     	   }
     	   if (checkboxes.length == 1){
     		   $("button:contains('Modify Order')").removeAttr('disabled');
     	   }        	   
        });
    },
    sort_by_date_order:function(){
    	var self = this;
    	if (self.offline_pos_orders){
    		var list = []
    		_.each (self.offline_pos_orders.orders,function(order){
        		list.push(order);
        	});
        	list = list.sort(function(a,b) {
        		if (a.date_order == b.date_order){
        			return a.partner_id[1] - b.partner_id[1]
        		}else{
        			a = new Date(a.date_order);
        			b = new Date(b.date_order);
        			return  b-a ;
        		}
    		});
        	return list
    	}
    },
    get_order: function(customer_id,args){ 
    	var self = this;
    	var model = new instance.web.Model('pos.order');
    	$(".corder-list-contents").empty();
    	if (! _.isEmpty(self.offline_pos_orders.orders)){
    		if (customer_id && args){
    			_.each(self.sort_by_date_order(),function(rec){
    	    		if (rec.partner_id[0] == parseInt(customer_id) && (args.indexOf(rec.state) != -1)){
    	    			$("#corder_pos").append(QWeb.render('CordersList',{'order':rec}));
    	    		}    			    				
    			})
        	}else{
        		_.each(self.sort_by_date_order(),function(rec){
            		$("#corder_pos").append(QWeb.render('CordersList',{'order':rec}));        			
        		})
        	}    		
    	}

        $('#search_orders input').on('keyup',function(event){
        	var query = (this.value);
        	var search_timeout = null;
        	clearTimeout(search_timeout);
            search_timeout = setTimeout(function(){
            	$(".corder-list-contents").empty();
            	for (order in self.pos_widget.offline_pos_orders.order_search_string){
              	  if (self.pos_widget.offline_pos_orders.order_search_string[order].match(query)){
              		  $("#corder_pos").append(QWeb.render('CordersList',{'order':self.offline_pos_orders.orders[order]}));
              	  }
                }
            	self.change_event(customer_id,args);
            },0);
       });
       self.change_event(customer_id,args);
    },

    clock: function(){
        var self = this;
        self.$el.find(".username").after("<span class='clock'></span>");
        function clock(){
            var time = new Date();
            var hr = time.getHours();
            var min = time.getMinutes();
            var sec = time.getSeconds();
            var year = time.getYear();
            add_zero =  function(num){
                if(num < 10){
                    return "0" + num;
                }
                return num;
            };
            var ampm = " PM ";
            if (hr < 12)ampm = " AM ";
            if (hr > 12)hr -= 12;
            if (hr < 10)hr = " " + hr;
            if (min < 10)min = add_zero(min);
            if (sec < 10)sec = add_zero(sec);
            if(year < 1000)year += 1900;
            var value = hr + ":" + min + ":" + sec + ampm +""+add_zero(time.getDate())+"/"+add_zero(time.getMonth())+"/"+year;
            self.$el.find(".clock").html(value);
        };
        setInterval(function(){ clock(); }, 1000);
    },
    close: function(){
        var self = this;
        function close(){
            if (confirm(_t("Are you sure?"))){
                self.pos.push_order().then(function(){
                    self.pos.modify_order();
                    self.pos.pay_orders();
                	instance.jsonRpc("/poscustom/close", "session_close", {}).then(function(res){
                        if (res.is_user){
                            return instance.web.logout();
                        }
                    return new instance.web.Model("ir.model.data").get_func("search_read")([['name', '=', 'action_client_pos_menu']], ['res_id']).pipe(function(res) {
                        window.location = '/web#action=' + res[0]['res_id'];
                    },function(err,event) {
                        event.preventDefault();
                        self.screen_selector.show_popup('error',{
                            'message': _t('Could not close the point of sale.'),
                            'comment': _t('Your internet connection is probably down.'),
                        });
                        self.close_button.renderElement();
                    });
                    });
                });

            }
        }

        var draft_order = _.find( self.pos.get('orders').models, function(order){
            return order.get('orderLines').length !== 0 && order.get('paymentLines').length === 0;
        });
        if(draft_order){
            if (confirm(_t("Pending orders will be lost.\nAre you sure you want to leave this session?"))) {
                close();
            }
        }else{
            close();
        }
    }
});

module.PaymentScreenWidget.include({
    validate_order: function(options) {
        var self = this;
        options = options || {};
        
        var currentOrder = this.pos.get('selectedOrder');
        if(currentOrder.get('orderLines').models.length === 0){
            this.pos_widget.screen_selector.show_popup('error',{
                'message': _t('Empty Order'),
                'comment': _t('There must be at least one product in your order before it can be validated'),
            });
            return;
        }

        var plines = currentOrder.get('paymentLines').models;
        for (var i = 0; i < plines.length; i++) {
            if (plines[i].get_type() === 'bank' && plines[i].get_amount() < 0) {
                this.pos_widget.screen_selector.show_popup('error',{
                    'message': _t('Negative Bank Payment'),
                    'comment': _t('You cannot have a negative amount in a Bank payment. Use a cash payment method to return money to the customer.'),
                });
                return;
            }
        }

        if(!this.is_paid()){
            return;
        }

        // The exact amount must be paid if there is no cash payment method defined.
        if (Math.abs(currentOrder.getTotalTaxIncluded() - currentOrder.getPaidTotal()) > 0.00001) {
            var cash = false;
            for (var i = 0; i < this.pos.cashregisters.length; i++) {
                cash = cash || (this.pos.cashregisters[i].journal.type === 'cash');
            }
            if (!cash) {
                this.pos_widget.screen_selector.show_popup('error',{
                    message: _t('Cannot return change without a cash payment method'),
                    comment: _t('There is no cash payment method available in this point of sale to handle the change.\n\n Please pay the exact amount or add a cash payment method in the point of sale configuration'),
                });
                return;
            }
        }
        if (this.pos.config.iface_cashdrawer) {
                this.pos.proxy.open_cashbox();
        }
        if(options.invoice){
            // deactivate the validation button while we try to send the order
            this.pos_widget.action_bar.set_button_disabled('validation',true);
            this.pos_widget.action_bar.set_button_disabled('invoice',true);

            var invoiced = this.pos.push_and_invoice_order(currentOrder);

            invoiced.fail(function(error){
                if(error === 'error-no-client'){
                    self.pos_widget.screen_selector.show_popup('error',{
                        message: _t('An anonymous order cannot be invoiced'),
                        comment: _t('Please select a client for this order. This can be done by clicking the order tab'),
                    });
                }else{
                    self.pos_widget.screen_selector.show_popup('error',{
                        message: _t('The order could not be sent'),
                        comment: _t('Check your internet connection and try again.'),
                    });
                }
                
                self.pos_widget.action_bar.set_button_disabled('validation',false);
                self.pos_widget.action_bar.set_button_disabled('invoice',false);
            });

            invoiced.done(function(){
                self.pos_widget.action_bar.set_button_disabled('validation',false);
                self.pos_widget.action_bar.set_button_disabled('invoice',false);
                self.pos.get('selectedOrder').destroy();
            });

        }else{  
        	var checkboxes = document.querySelectorAll("input[name='sex'][type='checkbox']:checked");
    		for(i=0;i<checkboxes.length;i++){
        		order = checkboxes[i];
        		if ($($(order).siblings()[0]).text() == 'unsaved'){
        			if (self.pos_widget.offline_pos_orders.orders[$(order).val()].amount_paid == undefined)
        				{
        				order_id = self.pos_widget.offline_pos_orders.orders[$(order).val()].name.split(' ')[1];
        				self.pos_widget.offline_pos_orders.orders[$(order).val()].amount_paid = currentOrder.getPaidTotal();
        				_.each(self.pos.db.cache.orders,function(order){
        					if (order.id == order_id){
        						statement_ids = [0,0,{ 
        	        	                name: instance.web.datetime_to_str(new Date()),
        	        	                statement_id: self.pos.cashregisters[0].id,
        	        	                account_id: self.pos.cashregisters[0].account_id[0],
        	        	                journal_id: self.pos.cashregisters[0].journal_id[0],
        	        	                amount: parseFloat(currentOrder.getPaidTotal()),
        						}];
        						order.data.amount_return = currentOrder.getPaidTotal() - currentOrder.getTotalTaxIncluded();
        						order.amount_paid = currentOrder.getPaidTotal();
        						order.data.statement_ids.push(statement_ids);
        						order.data.amount_paid = currentOrder.getPaidTotal();
        					}
        				});
        				self.pos.get('selectedOrder').destroy();
        				self.pos_widget.switch_to_order();
        				return ;
        				}else{
            				self.pos.get('selectedOrder').destroy();
            				self.pos_widget.switch_to_order();
        					self.pos_widget.screen_selector.show_popup('error',{
                                message: _t('Unsaved'),
                                comment: _t('The Unsaved Order has already been paid'),
                            });        			
        					return;
        				}
        		}                    		
        	}                		
        	if (self.pos_widget.modify_orders_widget.pay_list.length > 0){
        		if (currentOrder.getPaidTotal() >= currentOrder.getTotalTaxIncluded()){
        			var model = new instance.web.Model('pos.order')
        			_.each(self.pos_widget.modify_orders_widget.pay_list,function(item){
        				self.pos_widget.offline_pos_orders.orders[item]['state'] = 'paid';         				
        			})
        			model.call('payment_recieved',[self.pos.cashregisters[0].journal_id[0], {'order_ids':self.pos_widget.modify_orders_widget.pay_list} , {'session_id':self.pos.pos_session.id}]).then(function(){
        				self.pos_widget.modify_orders_widget.pay_list = [];
        	            if(self.pos.config.iface_print_via_proxy){
        	                var receipt = currentOrder.export_for_printing();
        	                self.pos.proxy.print_receipt(QWeb.render('XmlReceipt',{
        	                    receipt: receipt, widget: self,
        	                }));
        	                self.pos.get('selectedOrder').destroy();    //finish order and go back to scan screen
        	            }else{
        	                self.pos_widget.screen_selector.set_current_screen(self.next_screen);
        	            }
        			},function(err,event){ 
        				event.preventDefault();
        				self.pos_widget.offline_pos_orders.pay_list.push(
        						{'journal_id':self.pos.cashregisters[0].journal_id[0],'order_ids':self.pos_widget.modify_orders_widget.pay_list,'session_id':self.pos.pos_session.id}
        				)
        				self.pos_widget.offline_pos_orders.pay_list = _.uniq(self.pos_widget.offline_pos_orders.pay_list, 'order_ids')
        				self.pos.get('selectedOrder').destroy();
        	    		self.pos_widget.switch_to_order(); 
        			});
        		}
        		else{
        			self.pos_widget.screen_selector.show_popup('error',{
                        message: _t('Mismatch'),
                        comment: _t('The due total does not match the paid total'),
                    });        			
        		}
        	}
        	else{
            	this.pos.push_order(currentOrder)
                if(this.pos.config.iface_print_via_proxy){
                    var receipt = currentOrder.export_for_printing();
                    this.pos.proxy.print_receipt(QWeb.render('XmlReceipt',{
                        receipt: receipt, widget: self,
                    }));
                    this.pos.get('selectedOrder').destroy();    //finish order and go back to scan screen
                }else{
                    this.pos_widget.screen_selector.set_current_screen(this.next_screen);
                }            	
        	}
    	}

        // hide onscreen (iOS) keyboard 
        setTimeout(function(){
            document.activeElement.blur();
            $("input").blur();
        },250);
    },	
    back: function() {
    	if (this.pos_widget.modify_orders_widget.pay_list.length > 0){
    		this.pos.get('selectedOrder').destroy();
    		this.pos_widget.switch_to_order(); 
    		this.pos_widget.modify_orders_widget.pay_list = [];
    	}
    	else{
    		this.pos_widget.screen_selector.set_current_screen(this.back_screen);
    	}
    	this.remove_empty_lines();
    },	
}); 
	

module.Order = module.Order.extend({
    addOrderline: function(line){
        line.order = this;
        this.get('orderLines').add(line);
        this.selectLine(this.getLastOrderline());
    },
});
};